import {Fragment, useCallback, useEffect, useMemo, useState} from 'react';
import {useTheme} from '@emotion/react';
import styled from '@emotion/styled';
import debounce from 'lodash/debounce';
import omit from 'lodash/omit';
import moment from 'moment';

import {Alert} from 'sentry/components/alert';
import {Button} from 'sentry/components/button';
import Count from 'sentry/components/count';
import EmptyStateWarning, {EmptyStreamWrapper} from 'sentry/components/emptyStateWarning';
import * as Layout from 'sentry/components/layouts/thirds';
import ExternalLink from 'sentry/components/links/externalLink';
import LoadingIndicator from 'sentry/components/loadingIndicator';
import {DatePageFilter} from 'sentry/components/organizations/datePageFilter';
import {EnvironmentPageFilter} from 'sentry/components/organizations/environmentPageFilter';
import PageFilterBar from 'sentry/components/organizations/pageFilterBar';
import {normalizeDateTimeParams} from 'sentry/components/organizations/pageFilters/parse';
import {ProjectPageFilter} from 'sentry/components/organizations/projectPageFilter';
import Panel from 'sentry/components/panels/panel';
import PanelHeader from 'sentry/components/panels/panelHeader';
import PanelItem from 'sentry/components/panels/panelItem';
import PerformanceDuration from 'sentry/components/performanceDuration';
import {Tooltip} from 'sentry/components/tooltip';
import {IconArrow} from 'sentry/icons/iconArrow';
import {IconChevron} from 'sentry/icons/iconChevron';
import {IconClose} from 'sentry/icons/iconClose';
import {IconWarning} from 'sentry/icons/iconWarning';
import {t, tct} from 'sentry/locale';
import {space} from 'sentry/styles/space';
import type {PageFilters} from 'sentry/types/core';
import type {MRI} from 'sentry/types/metrics';
import type {Organization} from 'sentry/types/organization';
import {trackAnalytics} from 'sentry/utils/analytics';
import {browserHistory} from 'sentry/utils/browserHistory';
import {getUtcDateString} from 'sentry/utils/dates';
import {getFormattedMQL} from 'sentry/utils/metrics';
import {useApiQuery} from 'sentry/utils/queryClient';
import {decodeInteger, decodeList, decodeScalar} from 'sentry/utils/queryString';
import {useLocation} from 'sentry/utils/useLocation';
import useOrganization from 'sentry/utils/useOrganization';
import usePageFilters from 'sentry/utils/usePageFilters';
import useProjects from 'sentry/utils/useProjects';
import * as ModuleLayout from 'sentry/views/insights/common/components/moduleLayout';

import {type Field, FIELDS, SORTS} from './data';
import {
  BREAKDOWN_SLICES,
  ProjectRenderer,
  SpanBreakdownSliceRenderer,
  SpanDescriptionRenderer,
  SpanIdRenderer,
  SpanTimeRenderer,
  TraceBreakdownContainer,
  TraceBreakdownRenderer,
  TraceIdRenderer,
  TraceIssuesRenderer,
} from './fieldRenderers';
import {TracesChart} from './tracesChart';
import {TracesSearchBar} from './tracesSearchBar';
import {
  ALL_PROJECTS,
  areQueriesEmpty,
  getSecondaryNameFromSpan,
  getStylingSliceName,
  normalizeTraces,
} from './utils';

const DEFAULT_PER_PAGE = 50;
const SPAN_PROPS_DOCS_URL =
  'https://docs.sentry.io/concepts/search/searchable-properties/spans/';
const ONE_MINUTE = 60 * 1000; // in milliseconds

function usePageParams(location) {
  const queries = useMemo(() => {
    return decodeList(location.query.query);
  }, [location.query.query]);

  const metricsMax = decodeScalar(location.query.metricsMax);
  const metricsMin = decodeScalar(location.query.metricsMin);
  const metricsOp = decodeScalar(location.query.metricsOp);
  const metricsQuery = decodeScalar(location.query.metricsQuery);
  const mri = decodeScalar(location.query.mri);

  return {
    queries,
    metricsMax,
    metricsMin,
    metricsOp,
    metricsQuery,
    mri,
  };
}

export function Content() {
  const location = useLocation();

  const organization = useOrganization();

  const limit = useMemo(() => {
    return decodeInteger(location.query.perPage, DEFAULT_PER_PAGE);
  }, [location.query.perPage]);

  const {queries, metricsMax, metricsMin, metricsOp, metricsQuery, mri} =
    usePageParams(location);

  const hasMetric = metricsOp && mri;

  const removeMetric = useCallback(() => {
    browserHistory.push({
      ...location,
      query: omit(location.query, [
        'mri',
        'metricsOp',
        'metricsQuery',
        'metricsMax',
        'metricsMin',
      ]),
    });
  }, [location]);

  const handleSearch = useCallback(
    (searchIndex: number, searchQuery: string) => {
      const newQueries = [...queries];
      if (newQueries.length === 0) {
        // In the odd case someone wants to add search bars before any query has been made, we add both the default one shown and a new one.
        newQueries[0] = '';
      }
      newQueries[searchIndex] = searchQuery;
      browserHistory.push({
        ...location,
        query: {
          ...location.query,
          cursor: undefined,
          query: typeof searchQuery === 'string' ? newQueries : queries,
        },
      });
    },
    [location, queries]
  );

  const handleClearSearch = useCallback(
    (searchIndex: number) => {
      const newQueries = [...queries];
      if (typeof newQueries[searchIndex] !== undefined) {
        delete newQueries[searchIndex];
        browserHistory.push({
          ...location,
          query: {
            ...location.query,
            cursor: undefined,
            query: newQueries,
          },
        });
        return true;
      }
      return false;
    },
    [location, queries]
  );

  const sortByTimestamp = organization.features.includes(
    'performance-trace-explorer-sorting'
  );

  const tracesQuery = useTraces({
    limit,
    query: queries,
    sort: sortByTimestamp ? '-timestamp' : undefined,
    mri: hasMetric ? mri : undefined,
    metricsMax: hasMetric ? metricsMax : undefined,
    metricsMin: hasMetric ? metricsMin : undefined,
    metricsOp: hasMetric ? metricsOp : undefined,
    metricsQuery: hasMetric ? metricsQuery : undefined,
  });

  const isLoading = tracesQuery.isFetching;
  const isError = !isLoading && tracesQuery.isError;
  const isEmpty = !isLoading && !isError && (tracesQuery?.data?.data?.length ?? 0) === 0;
  const rawData = !isLoading && !isError ? tracesQuery?.data?.data : undefined;
  const data = sortByTimestamp ? rawData : normalizeTraces(rawData);

  return (
    <LayoutMain fullWidth>
      <PageFilterBar condensed>
        <Tooltip
          title={tct(
            "Traces stem across multiple projects. You'll need to narrow down which projects you'd like to include per span.[br](ex. [code:project:javascript])",
            {
              br: <br />,
              code: <Code />,
            }
          )}
          position="bottom"
        >
          <ProjectPageFilter disabled projectOverride={ALL_PROJECTS} />
        </Tooltip>
        <EnvironmentPageFilter />
        <DatePageFilter defaultPeriod="2h" />
      </PageFilterBar>
      {hasMetric && (
        <StyledAlert
          type="info"
          showIcon
          trailingItems={<StyledCloseButton onClick={removeMetric} />}
        >
          {tct('The metric query [metricQuery] is filtering the results below.', {
            metricQuery: (
              <strong>
                {getFormattedMQL({mri: mri as MRI, op: metricsOp, query: metricsQuery})}
              </strong>
            ),
          })}
        </StyledAlert>
      )}
      {isError && typeof tracesQuery.error?.responseJSON?.detail === 'string' ? (
        <StyledAlert type="error" showIcon>
          {tracesQuery.error?.responseJSON?.detail}
        </StyledAlert>
      ) : null}
      <TracesSearchBar
        queries={queries}
        handleSearch={handleSearch}
        handleClearSearch={handleClearSearch}
      />

      <ModuleLayout.Full>
        <TracesChart />
      </ModuleLayout.Full>
      <StyledPanel>
        <TracePanelContent>
          <StyledPanelHeader align="left" lightText>
            {t('Trace ID')}
          </StyledPanelHeader>
          <StyledPanelHeader align="left" lightText>
            {t('Trace Root')}
          </StyledPanelHeader>
          <StyledPanelHeader align="right" lightText>
            {areQueriesEmpty(queries) ? t('Total Spans') : t('Matching Spans')}
          </StyledPanelHeader>
          <StyledPanelHeader align="left" lightText>
            {t('Timeline')}
          </StyledPanelHeader>
          <StyledPanelHeader align="right" lightText>
            {t('Duration')}
          </StyledPanelHeader>
          <StyledPanelHeader align="right" lightText>
            {t('Timestamp')}
            {sortByTimestamp ? <IconArrow size="xs" direction="down" /> : null}
          </StyledPanelHeader>
          <StyledPanelHeader align="right" lightText>
            {t('Issues')}
          </StyledPanelHeader>
          {isLoading && (
            <StyledPanelItem span={7} overflow>
              <LoadingIndicator />
            </StyledPanelItem>
          )}
          {isError && ( // TODO: need an error state
            <StyledPanelItem span={7} overflow>
              <EmptyStreamWrapper>
                <IconWarning color="gray300" size="lg" />
              </EmptyStreamWrapper>
            </StyledPanelItem>
          )}
          {isEmpty && (
            <StyledPanelItem span={7} overflow>
              <EmptyStateWarning withIcon>
                <EmptyStateText size="fontSizeExtraLarge">
                  {t('No trace results found')}
                </EmptyStateText>
                <EmptyStateText size="fontSizeMedium">
                  {tct('Try adjusting your filters or refer to [docSearchProps].', {
                    docSearchProps: (
                      <ExternalLink href={SPAN_PROPS_DOCS_URL}>
                        {t('docs for search properties')}
                      </ExternalLink>
                    ),
                  })}
                </EmptyStateText>
              </EmptyStateWarning>
            </StyledPanelItem>
          )}
          {data?.map((trace, i) => (
            <TraceRow key={trace.trace} trace={trace} defaultExpanded={i === 0} />
          ))}
        </TracePanelContent>
      </StyledPanel>
    </LayoutMain>
  );
}

function TraceRow({defaultExpanded, trace}: {defaultExpanded; trace: TraceResult}) {
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);
  const [highlightedSliceName, _setHighlightedSliceName] = useState('');
  const location = useLocation();
  const organization = useOrganization();
  const queries = useMemo(() => {
    return decodeList(location.query.query);
  }, [location.query.query]);

  const setHighlightedSliceName = useMemo(
    () =>
      debounce(sliceName => _setHighlightedSliceName(sliceName), 100, {
        leading: true,
      }),
    [_setHighlightedSliceName]
  );

  const onClickExpand = useCallback(() => setExpanded(e => !e), [setExpanded]);

  return (
    <Fragment>
      <StyledPanelItem align="center" center onClick={onClickExpand}>
        <Button
          icon={<IconChevron size="xs" direction={expanded ? 'down' : 'right'} />}
          aria-label={t('Toggle trace details')}
          aria-expanded={expanded}
          size="zero"
          borderless
          onClick={() =>
            trackAnalytics('trace_explorer.toggle_trace_details', {
              organization,
              expanded,
            })
          }
        />
        <TraceIdRenderer
          traceId={trace.trace}
          timestamp={trace.end}
          onClick={() =>
            trackAnalytics('trace_explorer.open_trace', {
              organization,
            })
          }
          location={location}
        />
      </StyledPanelItem>
      <StyledPanelItem align="left" overflow>
        <Description>
          {trace.project ? (
            <ProjectRenderer projectSlug={trace.project} hideName />
          ) : null}
          {trace.name ? (
            <WrappingText>{trace.name}</WrappingText>
          ) : (
            <EmptyValueContainer>{t('Missing Trace Root')}</EmptyValueContainer>
          )}
        </Description>
      </StyledPanelItem>
      <StyledPanelItem align="right">
        {areQueriesEmpty(queries) ? (
          <Count value={trace.numSpans} />
        ) : (
          tct('[numerator][space]of[space][denominator]', {
            numerator: <Count value={trace.matchingSpans} />,
            denominator: <Count value={trace.numSpans} />,
            space: <Fragment>&nbsp;</Fragment>,
          })
        )}
      </StyledPanelItem>
      <BreakdownPanelItem
        align="right"
        highlightedSliceName={highlightedSliceName}
        onMouseLeave={() => setHighlightedSliceName('')}
      >
        <TraceBreakdownRenderer
          trace={trace}
          setHighlightedSliceName={setHighlightedSliceName}
        />
      </BreakdownPanelItem>
      <StyledPanelItem align="right">
        <PerformanceDuration milliseconds={trace.duration} abbreviation />
      </StyledPanelItem>
      <StyledPanelItem align="right">
        <SpanTimeRenderer timestamp={trace.end} tooltipShowSeconds />
      </StyledPanelItem>
      <StyledPanelItem align="right">
        <TraceIssuesRenderer
          trace={trace}
          onClick={() =>
            trackAnalytics('trace_explorer.open_in_issues', {
              organization,
            })
          }
        />
      </StyledPanelItem>
      {expanded && (
        <SpanTable trace={trace} setHighlightedSliceName={setHighlightedSliceName} />
      )}
    </Fragment>
  );
}

function SpanTable({
  trace,
  setHighlightedSliceName,
}: {
  setHighlightedSliceName: (sliceName: string) => void;
  trace: TraceResult;
}) {
  const location = useLocation();
  const organization = useOrganization();

  const {queries, metricsMax, metricsMin, metricsOp, metricsQuery, mri} =
    usePageParams(location);
  const hasMetric = metricsOp && mri;

  const spansQuery = useTraceSpans({
    trace,
    fields: [
      ...FIELDS,
      ...SORTS.map(field =>
        field.startsWith('-') ? (field.substring(1) as Field) : (field as Field)
      ),
    ],
    datetime: {
      // give a 1 minute buffer on each side so that start != end
      start: getUtcDateString(moment(trace.start - ONE_MINUTE)),
      end: getUtcDateString(moment(trace.end + ONE_MINUTE)),
      period: null,
      utc: true,
    },
    limit: 10,
    query: queries,
    sort: SORTS,
    mri: hasMetric ? mri : undefined,
    metricsMax: hasMetric ? metricsMax : undefined,
    metricsMin: hasMetric ? metricsMin : undefined,
    metricsOp: hasMetric ? metricsOp : undefined,
    metricsQuery: hasMetric ? metricsQuery : undefined,
  });

  const isLoading = spansQuery.isFetching;
  const isError = !isLoading && spansQuery.isError;
  const hasData = !isLoading && !isError && (spansQuery?.data?.data?.length ?? 0) > 0;
  const spans = spansQuery.data?.data ?? [];

  return (
    <SpanTablePanelItem span={7} overflow>
      <StyledPanel>
        <SpanPanelContent>
          <StyledPanelHeader align="left" lightText>
            {t('Span ID')}
          </StyledPanelHeader>
          <StyledPanelHeader align="left" lightText>
            {t('Span Description')}
          </StyledPanelHeader>
          <StyledPanelHeader align="right" lightText />
          <StyledPanelHeader align="right" lightText>
            {t('Span Duration')}
          </StyledPanelHeader>
          <StyledPanelHeader align="right" lightText>
            {t('Timestamp')}
          </StyledPanelHeader>
          {isLoading && (
            <StyledPanelItem span={5} overflow>
              <LoadingIndicator />
            </StyledPanelItem>
          )}
          {isError && ( // TODO: need an error state
            <StyledPanelItem span={5} overflow>
              <EmptyStreamWrapper>
                <IconWarning color="gray300" size="lg" />
              </EmptyStreamWrapper>
            </StyledPanelItem>
          )}
          {spans.map(span => (
            <SpanRow
              organization={organization}
              key={span.id}
              span={span}
              trace={trace}
              setHighlightedSliceName={setHighlightedSliceName}
            />
          ))}
          {hasData && spans.length < trace.matchingSpans && (
            <MoreMatchingSpans span={5}>
              {tct('[more][space]more [matching]spans can be found in the trace.', {
                more: <Count value={trace.matchingSpans - spans.length} />,
                space: <Fragment>&nbsp;</Fragment>,
                matching: areQueriesEmpty(queries) ? '' : 'matching ',
              })}
            </MoreMatchingSpans>
          )}
        </SpanPanelContent>
      </StyledPanel>
    </SpanTablePanelItem>
  );
}

function SpanRow({
  organization,
  span,
  trace,
  setHighlightedSliceName,
}: {
  organization: Organization;
  setHighlightedSliceName: (sliceName: string) => void;
  span: SpanResult<Field>;

  trace: TraceResult;
}) {
  const theme = useTheme();
  return (
    <Fragment>
      <StyledSpanPanelItem align="right">
        <SpanIdRenderer
          projectSlug={span.project}
          transactionId={span['transaction.id']}
          spanId={span.id}
          traceId={trace.trace}
          timestamp={span.timestamp}
          onClick={() =>
            trackAnalytics('trace_explorer.open_trace_span', {
              organization,
            })
          }
        />
      </StyledSpanPanelItem>
      <StyledSpanPanelItem align="left" overflow>
        <SpanDescriptionRenderer span={span} />
      </StyledSpanPanelItem>
      <StyledSpanPanelItem align="right" onMouseLeave={() => setHighlightedSliceName('')}>
        <TraceBreakdownContainer>
          <SpanBreakdownSliceRenderer
            sliceName={span.project}
            sliceSecondaryName={getSecondaryNameFromSpan(span)}
            sliceStart={Math.ceil(span['precise.start_ts'] * 1000)}
            sliceEnd={Math.floor(span['precise.finish_ts'] * 1000)}
            trace={trace}
            theme={theme}
            onMouseEnter={() =>
              setHighlightedSliceName(
                getStylingSliceName(span.project, getSecondaryNameFromSpan(span)) ?? ''
              )
            }
          />
        </TraceBreakdownContainer>
      </StyledSpanPanelItem>
      <StyledSpanPanelItem align="right">
        <PerformanceDuration milliseconds={span['span.duration']} abbreviation />
      </StyledSpanPanelItem>

      <StyledSpanPanelItem align="right">
        <SpanTimeRenderer
          timestamp={span['precise.finish_ts'] * 1000}
          tooltipShowSeconds
        />
      </StyledSpanPanelItem>
    </Fragment>
  );
}

export type SpanResult<F extends string> = Record<F, any>;

export interface TraceResult {
  breakdowns: TraceBreakdownResult[];
  duration: number;
  end: number;
  matchingSpans: number;
  name: string | null;
  numErrors: number;
  numOccurrences: number;
  numSpans: number;
  project: string | null;
  slices: number;
  start: number;
  trace: string;
}

interface TraceBreakdownBase {
  duration: number; // Contains the accurate duration for display. Start and end may be quantized.
  end: number;
  opCategory: string | null;
  sdkName: string | null;
  sliceEnd: number;
  sliceStart: number;
  sliceWidth: number;
  start: number;
}

type TraceBreakdownProject = TraceBreakdownBase & {
  kind: 'project';
  project: string;
};

type TraceBreakdownMissing = TraceBreakdownBase & {
  kind: 'missing';
  project: null;
};

export type TraceBreakdownResult = TraceBreakdownProject | TraceBreakdownMissing;

interface TraceResults {
  data: TraceResult[];
  meta: any;
}

interface UseTracesOptions {
  datetime?: PageFilters['datetime'];
  enabled?: boolean;
  limit?: number;
  metricsMax?: string;
  metricsMin?: string;
  metricsOp?: string;
  metricsQuery?: string;
  mri?: string;
  query?: string | string[];
  sort?: '-timestamp';
}

function useTraces({
  datetime,
  enabled,
  limit,
  mri,
  metricsMax,
  metricsMin,
  metricsOp,
  metricsQuery,
  query,
  sort,
}: UseTracesOptions) {
  const organization = useOrganization();
  const {projects} = useProjects();
  const {selection} = usePageFilters();

  const path = `/organizations/${organization.slug}/traces/`;

  const endpointOptions = {
    query: {
      project: selection.projects,
      environment: selection.environments,
      ...(datetime ?? normalizeDateTimeParams(selection.datetime)),
      query,
      sort,
      per_page: limit,
      breakdownSlices: BREAKDOWN_SLICES,
      mri,
      metricsMax,
      metricsMin,
      metricsOp,
      metricsQuery,
    },
  };
  const serializedEndpointOptions = JSON.stringify(endpointOptions);

  let queries: string[] = [];
  if (Array.isArray(query)) {
    queries = query;
  } else if (query !== undefined) {
    queries = [query];
  }

  useEffect(() => {
    trackAnalytics('trace_explorer.search_request', {
      organization,
      queries,
    });
    // `queries` is already included as a dep in serializedEndpointOptions
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serializedEndpointOptions, organization]);

  const result = useApiQuery<TraceResults>([path, endpointOptions], {
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
    enabled,
  });

  useEffect(() => {
    if (result.status === 'success') {
      const project_slugs = [...new Set(result.data.data.map(trace => trace.project))];
      const project_platforms = projects
        .filter(p => project_slugs.includes(p.slug))
        .map(p => p.platform ?? '');

      trackAnalytics('trace_explorer.search_success', {
        organization,
        queries,
        has_data: result.data.data.length > 0,
        num_traces: result.data.data.length,
        num_missing_trace_root: result.data.data.filter(trace => trace.name === null)
          .length,
        project_platforms,
      });
    } else if (result.status === 'error') {
      const response = result.error.responseJSON;
      const error =
        typeof response?.detail === 'string'
          ? response?.detail
          : response?.detail?.message;
      trackAnalytics('trace_explorer.search_failure', {
        organization,
        queries,
        error: error ?? '',
      });
    }
    // result.status is tied to result.data. No need to explicitly
    // include result.data as an additional dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serializedEndpointOptions, result.status, organization]);

  return result;
}

interface SpanResults<F extends string> {
  data: SpanResult<F>[];
  meta: any;
}

interface UseTraceSpansOptions<F extends string> {
  fields: F[];
  trace: TraceResult;
  datetime?: PageFilters['datetime'];
  enabled?: boolean;
  limit?: number;
  metricsMax?: string;
  metricsMin?: string;
  metricsOp?: string;
  metricsQuery?: string;
  mri?: string;
  query?: string | string[];
  sort?: string[];
}

function useTraceSpans<F extends string>({
  fields,
  trace,
  datetime,
  enabled,
  limit,
  mri,
  metricsMax,
  metricsMin,
  metricsOp,
  metricsQuery,
  query,
  sort,
}: UseTraceSpansOptions<F>) {
  const organization = useOrganization();
  const {selection} = usePageFilters();

  const path = `/organizations/${organization.slug}/trace/${trace.trace}/spans/`;

  const endpointOptions = {
    query: {
      environment: selection.environments,
      ...(datetime ?? normalizeDateTimeParams(selection.datetime)),
      field: fields,
      query,
      sort,
      per_page: limit,
      breakdownSlices: BREAKDOWN_SLICES,
      maxSpansPerTrace: 10,
      mri,
      metricsMax,
      metricsMin,
      metricsOp,
      metricsQuery,
    },
  };

  const result = useApiQuery<SpanResults<F>>([path, endpointOptions], {
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
    enabled,
  });

  return result;
}

const LayoutMain = styled(Layout.Main)`
  display: flex;
  flex-direction: column;
  gap: ${space(2)};
`;

const StyledPanel = styled(Panel)`
  margin-bottom: 0px;
`;

const TracePanelContent = styled('div')`
  width: 100%;
  display: grid;
  grid-template-columns: repeat(1, min-content) auto repeat(2, min-content) 85px 112px 66px;
`;

const SpanPanelContent = styled('div')`
  width: 100%;
  display: grid;
  grid-template-columns: repeat(1, min-content) auto repeat(1, min-content) 160px 85px;
`;

const StyledPanelHeader = styled(PanelHeader)<{align: 'left' | 'right'}>`
  white-space: nowrap;
  justify-content: ${p => (p.align === 'left' ? 'flex-start' : 'flex-end')};
`;

const EmptyStateText = styled('div')<{size: 'fontSizeExtraLarge' | 'fontSizeMedium'}>`
  color: ${p => p.theme.gray300};
  font-size: ${p => p.theme[p.size]};
  padding-bottom: ${space(1)};
`;

const Description = styled('div')`
  ${p => p.theme.overflowEllipsis};
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: ${space(1)};
`;

const StyledPanelItem = styled(PanelItem)<{
  align?: 'left' | 'center' | 'right';
  overflow?: boolean;
  span?: number;
}>`
  align-items: center;
  padding: ${space(1)} ${space(2)};
  ${p => (p.align === 'left' ? 'justify-content: flex-start;' : null)}
  ${p => (p.align === 'right' ? 'justify-content: flex-end;' : null)}
  ${p => (p.overflow ? p.theme.overflowEllipsis : null)};
  ${p =>
    p.align === 'center'
      ? `
  justify-content: space-around;`
      : p.align === 'left' || p.align === 'right'
        ? `text-align: ${p.align};`
        : undefined}
  ${p => p.span && `grid-column: auto / span ${p.span};`}
  white-space: nowrap;
`;

const MoreMatchingSpans = styled(StyledPanelItem)`
  color: ${p => p.theme.gray300};
`;

const WrappingText = styled('div')`
  width: 100%;
  ${p => p.theme.overflowEllipsis};
`;

const StyledSpanPanelItem = styled(StyledPanelItem)`
  &:nth-child(10n + 1),
  &:nth-child(10n + 2),
  &:nth-child(10n + 3),
  &:nth-child(10n + 4),
  &:nth-child(10n + 5) {
    background-color: ${p => p.theme.backgroundSecondary};
  }
`;

const SpanTablePanelItem = styled(StyledPanelItem)`
  background-color: ${p => p.theme.gray100};
`;

const BreakdownPanelItem = styled(StyledPanelItem)<{highlightedSliceName: string}>`
  ${p =>
    p.highlightedSliceName
      ? `--highlightedSlice-${p.highlightedSliceName}-opacity: 1.0;
         --highlightedSlice-${p.highlightedSliceName}-saturate: saturate(1.0) contrast(1.0);
         --highlightedSlice-${p.highlightedSliceName}-transform: translateY(0px);
       `
      : null}
  ${p =>
    p.highlightedSliceName
      ? `
        --defaultSlice-opacity: 1.0;
        --defaultSlice-saturate: saturate(0.7) contrast(0.9) brightness(1.2);
        --defaultSlice-transform: translateY(0px);
        `
      : `
        --defaultSlice-opacity: 1.0;
        --defaultSlice-saturate: saturate(1.0) contrast(1.0);
        --defaultSlice-transform: translateY(0px);
        `}
`;

const EmptyValueContainer = styled('span')`
  color: ${p => p.theme.gray300};
`;

const StyledAlert = styled(Alert)`
  margin-bottom: 0;
`;

const StyledCloseButton = styled(IconClose)`
  cursor: pointer;
`;

const Code = styled('code')`
  color: ${p => p.theme.red400};
`;
