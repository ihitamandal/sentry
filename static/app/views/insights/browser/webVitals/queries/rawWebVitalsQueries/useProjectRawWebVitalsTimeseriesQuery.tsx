import {getInterval} from 'sentry/components/charts/utils';
import type {Tag} from 'sentry/types';
import type {SeriesDataUnit} from 'sentry/types/echarts';
import type {MetaType} from 'sentry/utils/discover/eventView';
import EventView from 'sentry/utils/discover/eventView';
import type {DiscoverQueryProps} from 'sentry/utils/discover/genericDiscoverQuery';
import {useGenericDiscoverQuery} from 'sentry/utils/discover/genericDiscoverQuery';
import {DiscoverDatasets} from 'sentry/utils/discover/types';
import {MutableSearch} from 'sentry/utils/tokenizeSearch';
import {useLocation} from 'sentry/utils/useLocation';
import useOrganization from 'sentry/utils/useOrganization';
import usePageFilters from 'sentry/utils/usePageFilters';
import {calculatePerformanceScore} from 'sentry/views/insights/browser/webVitals/queries/rawWebVitalsQueries/calculatePerformanceScore';

type Props = {
  enabled?: boolean;
  tag?: Tag;
  transaction?: string | null;
};

export type WebVitalsScoreBreakdown = {
  cls: SeriesDataUnit[];
  fcp: SeriesDataUnit[];
  inp: SeriesDataUnit[];
  lcp: SeriesDataUnit[];
  total: SeriesDataUnit[];
  ttfb: SeriesDataUnit[];
};

export const useProjectRawWebVitalsTimeseriesQuery = ({
  transaction,
  tag,
  enabled = true,
}: Props) => {
  const pageFilters = usePageFilters();
  const location = useLocation();
  const organization = useOrganization();
  const search = new MutableSearch(['transaction.op:pageload']);
  if (transaction) {
    search.addFilterValue('transaction', transaction);
  }
  if (tag) {
    search.addFilterValue(tag.key, tag.name);
  }
  const projectTimeSeriesEventView = EventView.fromNewQueryWithPageFilters(
    {
      yAxis: [
        'p75(measurements.lcp)',
        'p75(measurements.fcp)',
        'p75(measurements.cls)',
        'p75(measurements.ttfb)',
        'count()',
      ],
      name: 'Web Vitals',
      query: search.formatString(),
      version: 2,
      fields: [],
      interval: getInterval(pageFilters.selection.datetime, 'low'),
      dataset: DiscoverDatasets.METRICS,
    },
    pageFilters.selection
  );

  const result = useGenericDiscoverQuery<
    {
      data: any[];
      meta: MetaType;
    },
    DiscoverQueryProps
  >({
    route: 'events-stats',
    eventView: projectTimeSeriesEventView,
    location,
    orgSlug: organization.slug,
    getRequestPayload: () => ({
      ...projectTimeSeriesEventView.getEventsAPIPayload(location),
      yAxis: projectTimeSeriesEventView.yAxis,
      topEvents: projectTimeSeriesEventView.topEvents,
      excludeOther: 0,
      partial: 1,
      orderby: undefined,
      interval: projectTimeSeriesEventView.interval,
    }),
    options: {
      enabled: pageFilters.isReady && enabled,
      refetchOnWindowFocus: false,
    },
    referrer: 'api.performance.browser.web-vitals.timeseries',
  });

  const data: WebVitalsScoreBreakdown = {
    lcp: [],
    fcp: [],
    cls: [],
    ttfb: [],
    inp: [],
    total: [],
  };

  result?.data?.['p75(measurements.lcp)']?.data.forEach((interval, index) => {
    const [lcp, fcp, cls, ttfb] = ['lcp', 'fcp', 'cls', 'ttfb'].map(webVital => {
      return result?.data?.[`p75(measurements.${webVital})`]?.data[index][1][0].count;
    });
    // This is kinda jank, but since events-stats zero fills, we need to assume that 0 values mean no data.
    // 0 value for a webvital is low frequency, but not impossible. We may need to figure out a better way to handle this in the future.
    const scores = calculatePerformanceScore({
      lcp: lcp === 0 ? Infinity : lcp,
      fcp: fcp === 0 ? Infinity : fcp,
      cls: cls === 0 ? Infinity : cls,
      ttfb: ttfb === 0 ? Infinity : ttfb,
    });

    ['total', 'lcp', 'fcp', 'cls', 'ttfb'].forEach(webVital => {
      data[webVital].push({
        value: scores[`${webVital}Score`],
        name: interval[0] * 1000,
      });
    });
  });

  return {data, isLoading: result.isLoading};
};
