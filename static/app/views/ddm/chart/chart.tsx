import {forwardRef, useCallback, useEffect, useMemo, useRef} from 'react';
import styled from '@emotion/styled';
import * as Sentry from '@sentry/react';
import Color from 'color';
import * as echarts from 'echarts/core';
import {CanvasRenderer} from 'echarts/renderers';

import {updateDateTime} from 'sentry/actionCreators/pageFilters';
import {transformToAreaSeries} from 'sentry/components/charts/areaChart';
import {transformToBarSeries} from 'sentry/components/charts/barChart';
import BaseChart from 'sentry/components/charts/baseChart';
import {
  defaultFormatAxisLabel,
  getFormatter,
} from 'sentry/components/charts/components/tooltip';
import {transformToLineSeries} from 'sentry/components/charts/lineChart';
import ScatterSeries from 'sentry/components/charts/series/scatterSeries';
import {type DateTimeObject, isChartHovered} from 'sentry/components/charts/utils';
import {t} from 'sentry/locale';
import type {ReactEchartsRef} from 'sentry/types/echarts';
import mergeRefs from 'sentry/utils/mergeRefs';
import {isCumulativeOp} from 'sentry/utils/metrics';
import {formatMetricsUsingUnitAndOp} from 'sentry/utils/metrics/formatters';
import {MetricDisplayType} from 'sentry/utils/metrics/types';
import useRouter from 'sentry/utils/useRouter';
import type {CombinedMetricChartProps, Series} from 'sentry/views/ddm/chart/types';
import {useFocusArea} from 'sentry/views/ddm/chart/useFocusArea';
import type {UseMetricSamplesResult} from 'sentry/views/ddm/chart/useMetricChartSamples';
import type {FocusAreaProps} from 'sentry/views/ddm/context';

export const MAIN_X_AXIS_ID = 'xAxis';
export const MAIN_Y_AXIS_ID = 'yAxis';

type ChartProps = {
  displayType: MetricDisplayType;
  series: Series[];
  widgetIndex: number;
  focusArea?: FocusAreaProps;
  group?: string;
  height?: number;
  samples?: UseMetricSamplesResult;
  samplesUnit?: string;
};

// We need to enable canvas renderer for echarts before we use it here.
// Once we use it in more places, this should probably move to a more global place
// But for now we keep it here to not invluence the bundle size of the main chunks.
echarts.use(CanvasRenderer);

function isNonZeroValue(value: number | null) {
  return value !== null && value !== 0;
}

function addSeriesPadding(data: Series['data']) {
  const hasNonZeroSibling = (index: number) => {
    return (
      isNonZeroValue(data[index - 1]?.value) || isNonZeroValue(data[index + 1]?.value)
    );
  };
  const paddingIndices = new Set<number>();
  return {
    data: data.map(({name, value}, index) => {
      const shouldAddPadding = value === null && hasNonZeroSibling(index);
      if (shouldAddPadding) {
        paddingIndices.add(index);
      }
      return {
        name,
        value: shouldAddPadding ? 0 : value,
      };
    }),
    paddingIndices,
  };
}

export const MetricChart = forwardRef<ReactEchartsRef, ChartProps>(
  (
    {series, displayType, widgetIndex, focusArea, height, samplesUnit, group, samples},
    forwardedRef
  ) => {
    const router = useRouter();
    const chartRef = useRef<ReactEchartsRef>(null);

    const handleZoom = useCallback(
      (range: DateTimeObject) => {
        Sentry.metrics.increment('ddm.enhance.zoom');
        updateDateTime(range, router, {save: true});
      },
      [router]
    );

    const firstUnit = series.find(s => !s.hidden)?.unit || series[0]?.unit || 'none';
    const firstOperation =
      series.find(s => !s.hidden)?.operation || series[0]?.operation || '';
    const hasCumulativeOp = series.some(s => isCumulativeOp(s.operation));

    const focusAreaBrush = useFocusArea({
      ...focusArea,
      sampleUnit: samplesUnit,
      chartUnit: firstUnit,
      chartRef,
      opts: {
        widgetIndex,
        isDisabled: !focusArea?.onAdd || !handleZoom,
        useFullYAxis: hasCumulativeOp,
      },
      onZoom: handleZoom,
    });

    useEffect(() => {
      if (!group) {
        return;
      }
      const echartsInstance = chartRef?.current?.getEchartsInstance();
      if (echartsInstance && !echartsInstance.group) {
        echartsInstance.group = group;
      }
    });

    // TODO(ddm): This assumes that all series have the same bucket size
    const bucketSize = series[0]?.data[1]?.name - series[0]?.data[0]?.name;
    const isSubMinuteBucket = bucketSize < 60_000;
    const lastBucketTimestamp = series[0]?.data?.[series[0]?.data?.length - 1]?.name;
    const ingestionBuckets = useMemo(
      () => getIngestionDelayBucketCount(bucketSize, lastBucketTimestamp),
      [bucketSize, lastBucketTimestamp]
    );

    const seriesToShow = useMemo(
      () =>
        series
          .filter(s => !s.hidden)
          .map(s => ({
            ...s,
            silent: true,
            ...(displayType !== MetricDisplayType.BAR
              ? addSeriesPadding(s.data)
              : {data: s.data}),
          }))
          // Split series in two parts, one for the main chart and one for the fog of war
          // The order is important as the tooltip will show the first series first (for overlaps)
          .flatMap(s => createIngestionSeries(s, ingestionBuckets, displayType)),
      [series, ingestionBuckets, displayType]
    );

    const chartProps = useMemo(() => {
      const hasMultipleUnits = new Set(seriesToShow.map(s => s.unit)).size > 1;
      const seriesMeta = seriesToShow.reduce(
        (acc, s) => {
          acc[s.seriesName] = {
            unit: s.unit,
            operation: s.operation,
          };
          return acc;
        },
        {} as Record<string, {operation: string; unit: string}>
      );

      const timeseriesFormatters = {
        valueFormatter: (value: number, seriesName?: string) => {
          const meta = seriesName
            ? seriesMeta[seriesName]
            : {unit: firstUnit, operation: undefined};
          return formatMetricsUsingUnitAndOp(value, meta.unit, meta.operation);
        },
        isGroupedByDate: true,
        bucketSize,
        showTimeInTooltip: true,
        addSecondsToTimeFormat: isSubMinuteBucket,
        limit: 10,
        filter: (_, seriesParam) => {
          return seriesParam?.axisId === 'xAxis';
        },
      };

      const heightOptions = height ? {height} : {autoHeightResize: true};

      let baseChartProps: CombinedMetricChartProps = {
        ...heightOptions,
        ...focusAreaBrush.options,
        displayType,
        forwardedRef: mergeRefs([forwardedRef, chartRef]),
        series: seriesToShow,
        devicePixelRatio: 2,
        renderer: 'canvas' as const,
        isGroupedByDate: true,
        colors: seriesToShow.map(s => s.color),
        grid: {top: 5, bottom: 0, left: 0, right: 0},
        tooltip: {
          formatter: (params, asyncTicket) => {
            // Only show the tooltip if the current chart is hovered
            // as chart groups trigger the tooltip for all charts in the group when one is hoverered
            if (!isChartHovered(chartRef?.current)) {
              return '';
            }

            if (focusAreaBrush.isDrawingRef.current) {
              return '';
            }

            // The mechanism by which we display ingestion delay the chart, duplicates the series in the chart data
            // so we need to de-duplicate the series before showing the tooltip
            // this assumes that the first series is the main series and the second is the ingestion delay series
            if (Array.isArray(params)) {
              const uniqueSeries = new Set<string>();
              const deDupedParams = params.filter(param => {
                // Filter null values from tooltip
                if (param.value[1] === null) {
                  return false;
                }

                // scatter series (samples) have their own tooltip
                if (param.seriesType === 'scatter') {
                  return false;
                }

                // Filter padding datapoints from tooltip
                if (param.value[1] === 0) {
                  const currentSeries = seriesToShow[param.seriesIndex];
                  const paddingIndices =
                    'paddingIndices' in currentSeries
                      ? currentSeries.paddingIndices
                      : undefined;
                  if (paddingIndices?.has(param.dataIndex)) {
                    return false;
                  }
                }

                if (uniqueSeries.has(param.seriesName)) {
                  return false;
                }
                uniqueSeries.add(param.seriesName);
                return true;
              });

              const date = defaultFormatAxisLabel(
                params[0].value[0] as number,
                timeseriesFormatters.isGroupedByDate,
                false,
                timeseriesFormatters.showTimeInTooltip,
                timeseriesFormatters.addSecondsToTimeFormat,
                timeseriesFormatters.bucketSize
              );

              if (deDupedParams.length === 0) {
                return [
                  '<div class="tooltip-series">',
                  `<center>${t('No data available')}</center>`,
                  '</div>',
                  `<div class="tooltip-footer">${date}</div>`,
                ].join('');
              }
              return getFormatter(timeseriesFormatters)(deDupedParams, asyncTicket);
            }
            return getFormatter(timeseriesFormatters)(params, asyncTicket);
          },
        },
        yAxes: [
          {
            // used to find and convert datapoint to pixel position
            id: MAIN_Y_AXIS_ID,
            axisLabel: {
              formatter: (value: number) => {
                return formatMetricsUsingUnitAndOp(
                  value,
                  hasMultipleUnits ? 'none' : firstUnit,
                  firstOperation
                );
              },
            },
          },
        ],
        xAxes: [
          {
            // used to find and convert datapoint to pixel position
            id: MAIN_X_AXIS_ID,
            axisPointer: {
              snap: true,
            },
          },
        ],
      };

      if (samples?.applyChartProps) {
        baseChartProps = samples.applyChartProps(baseChartProps);
      }

      return baseChartProps;
    }, [
      seriesToShow,
      bucketSize,
      isSubMinuteBucket,
      height,
      focusAreaBrush.options,
      focusAreaBrush.isDrawingRef,
      displayType,
      forwardedRef,
      samples,
      firstUnit,
      firstOperation,
    ]);

    return (
      <ChartWrapper>
        {focusAreaBrush.overlay}
        <CombinedChart {...chartProps} />
      </ChartWrapper>
    );
  }
);

function CombinedChart({
  displayType,
  series,
  scatterSeries = [],
  ...chartProps
}: CombinedMetricChartProps) {
  const combinedSeries = useMemo(() => {
    if (displayType === MetricDisplayType.LINE) {
      return [
        ...transformToLineSeries({series}),
        ...transformToScatterSeries({series: scatterSeries, displayType}),
      ];
    }

    if (displayType === MetricDisplayType.BAR) {
      return [
        ...transformToBarSeries({series, stacked: true, animation: false}),
        ...transformToScatterSeries({series: scatterSeries, displayType}),
      ];
    }

    if (displayType === MetricDisplayType.AREA) {
      return [
        ...transformToAreaSeries({series, stacked: true, colors: chartProps.colors}),
        ...transformToScatterSeries({series: scatterSeries, displayType}),
      ];
    }

    return [];
  }, [displayType, scatterSeries, series, chartProps.colors]);

  return <BaseChart {...chartProps} series={combinedSeries} />;
}

function transformToScatterSeries({
  series,
  displayType,
}: {
  displayType: MetricDisplayType;
  series: Series[];
}) {
  return series.map(({seriesName, data: seriesData, ...options}) => {
    if (displayType === MetricDisplayType.BAR) {
      return ScatterSeries({
        ...options,
        name: seriesName,
        data: seriesData?.map(({value, name}) => ({value: [name, value]})),
      });
    }

    return ScatterSeries({
      ...options,
      name: seriesName,
      data: seriesData?.map(({value, name}) => [name, value]),
      animation: false,
    });
  });
}

function createIngestionSeries(
  orignalSeries: Series,
  ingestionBuckets: number,
  displayType: MetricDisplayType
) {
  if (ingestionBuckets < 1) {
    return [orignalSeries];
  }

  const series = [
    {
      ...orignalSeries,
      data: orignalSeries.data.slice(0, -ingestionBuckets),
    },
  ];

  if (displayType === MetricDisplayType.BAR) {
    series.push(createIngestionBarSeries(orignalSeries, ingestionBuckets));
  } else if (displayType === MetricDisplayType.AREA) {
    series.push(createIngestionAreaSeries(orignalSeries, ingestionBuckets));
  } else {
    series.push(createIngestionLineSeries(orignalSeries, ingestionBuckets));
  }

  return series;
}

const EXTRAPOLATED_AREA_STRIPE_IMG =
  'image://data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAABkCAYAAAC/zKGXAAAAMUlEQVR4Ae3KoREAIAwEsMKgrMeYj8BzyIpEZyTZda16mPVJFEVRFEVRFEVRFMWO8QB4uATKpuU51gAAAABJRU5ErkJggg==';

export const getIngestionSeriesId = (seriesId: string) => `${seriesId}-ingestion`;

function createIngestionBarSeries(series: Series, fogBucketCnt = 0) {
  return {
    ...series,
    id: getIngestionSeriesId(series.id),
    silent: true,
    data: series.data.map((data, index) => ({
      ...data,
      // W need to set a value for the non-fog of war buckets so that the stacking still works in echarts
      value: index < series.data.length - fogBucketCnt ? 0 : data.value,
    })),
    itemStyle: {
      opacity: 1,
      decal: {
        symbol: EXTRAPOLATED_AREA_STRIPE_IMG,
        dashArrayX: [6, 0],
        dashArrayY: [6, 0],
        rotation: Math.PI / 4,
      },
    },
  };
}

function createIngestionLineSeries(series: Series, fogBucketCnt = 0) {
  return {
    ...series,
    id: getIngestionSeriesId(series.id),
    silent: true,
    // We include the last non-fog of war bucket so that the line is connected
    data: series.data.slice(-fogBucketCnt - 1),
    lineStyle: {
      type: 'dotted',
    },
  };
}

function createIngestionAreaSeries(series: Series, fogBucketCnt = 0) {
  return {
    ...series,
    id: getIngestionSeriesId(series.id),
    silent: true,
    stack: 'fogOfWar',
    // We include the last non-fog of war bucket so that the line is connected
    data: series.data.slice(-fogBucketCnt - 1),
    lineStyle: {
      type: 'dotted',
      color: Color(series.color).lighten(0.3).string(),
    },
  };
}

const AVERAGE_INGESTION_DELAY_MS = 90_000;
/**
 * Calculates the number of buckets, affected by ingestion delay.
 * Based on the AVERAGE_INGESTION_DELAY_MS
 * @param bucketSize in ms
 * @param lastBucketTimestamp starting time of the last bucket in ms
 */
function getIngestionDelayBucketCount(bucketSize: number, lastBucketTimestamp: number) {
  const timeSinceLastBucket = Date.now() - (lastBucketTimestamp + bucketSize);
  const ingestionAffectedTime = Math.max(
    0,
    AVERAGE_INGESTION_DELAY_MS - timeSinceLastBucket
  );

  return Math.ceil(ingestionAffectedTime / bucketSize);
}

const ChartWrapper = styled('div')`
  position: relative;
  height: 100%;
`;