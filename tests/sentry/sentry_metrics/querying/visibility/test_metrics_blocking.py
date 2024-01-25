import pytest

from sentry.sentry_metrics.visibility import (
    MalformedBlockedMetricsPayloadError,
    block_metric,
    get_blocked_metrics,
    get_blocked_metrics_for_relay_config,
)
from sentry.sentry_metrics.visibility.metrics_blocking import (
    BLOCKED_METRICS_PROJECT_OPTION_KEY,
    BlockedMetric,
    block_tags_of_metric,
    unblock_metric,
    unblock_tags_of_metric,
)
from sentry.testutils.pytest.fixtures import django_db_all
from sentry.utils import json


@django_db_all
def test_apply_multiple_operations(default_project):
    mri_1 = "c:custom/page_click@none"
    mri_2 = "g:custom/page_load@millisecond"

    # We block a single metric.
    block_metric(mri_1, [default_project])

    blocked_metrics = sorted(
        json.loads(default_project.get_option(BLOCKED_METRICS_PROJECT_OPTION_KEY)),
        key=lambda v: v["metric_mri"],
    )
    assert len(blocked_metrics) == 1
    assert blocked_metrics[0]["metric_mri"] == mri_1
    assert blocked_metrics[0]["is_blocked"] is True
    assert blocked_metrics[0]["blocked_tags"] == []

    # We block tags of a blocked metric.
    block_tags_of_metric(mri_1, {"release", "transaction", "release"}, [default_project])

    blocked_metrics = json.loads(default_project.get_option(BLOCKED_METRICS_PROJECT_OPTION_KEY))
    assert len(blocked_metrics) == 1
    assert blocked_metrics[0]["metric_mri"] == mri_1
    assert blocked_metrics[0]["is_blocked"] is True
    assert sorted(blocked_metrics[0]["blocked_tags"]) == ["release", "transaction"]

    # We unblock a tag of a blocked metric.
    unblock_tags_of_metric(mri_1, {"transaction"}, [default_project])

    blocked_metrics = json.loads(default_project.get_option(BLOCKED_METRICS_PROJECT_OPTION_KEY))
    assert len(blocked_metrics) == 1
    assert blocked_metrics[0]["metric_mri"] == mri_1
    assert blocked_metrics[0]["is_blocked"]
    assert sorted(blocked_metrics[0]["blocked_tags"]) == ["release"]

    # We block tags of an unblocked metric.
    block_tags_of_metric(mri_2, {"environment", "transaction"}, [default_project])

    blocked_metrics = json.loads(default_project.get_option(BLOCKED_METRICS_PROJECT_OPTION_KEY))
    assert len(blocked_metrics) == 2
    assert blocked_metrics[0]["metric_mri"] == mri_1
    assert blocked_metrics[0]["is_blocked"] is True
    assert sorted(blocked_metrics[0]["blocked_tags"]) == ["release"]
    assert blocked_metrics[1]["metric_mri"] == mri_2
    assert blocked_metrics[1]["is_blocked"] is False
    assert sorted(blocked_metrics[1]["blocked_tags"]) == ["environment", "transaction"]

    # We unblock all the tags of an unblocked metric.
    unblock_tags_of_metric(mri_2, {"environment", "transaction"}, [default_project])

    blocked_metrics = json.loads(default_project.get_option(BLOCKED_METRICS_PROJECT_OPTION_KEY))
    assert len(blocked_metrics) == 1
    assert blocked_metrics[0]["metric_mri"] == mri_1
    assert blocked_metrics[0]["is_blocked"] is True
    assert sorted(blocked_metrics[0]["blocked_tags"]) == ["release"]

    # We unblock a blocked metric with blocked tags.
    unblock_metric(mri_1, [default_project])

    blocked_metrics = json.loads(default_project.get_option(BLOCKED_METRICS_PROJECT_OPTION_KEY))
    assert len(blocked_metrics) == 1
    assert blocked_metrics[0]["metric_mri"] == mri_1
    assert blocked_metrics[0]["is_blocked"] is False
    assert sorted(blocked_metrics[0]["blocked_tags"]) == ["release"]

    # We unblock all the tags of an unblocked metric.
    unblock_tags_of_metric(mri_1, {"release", "transaction"}, [default_project])

    blocked_metrics = json.loads(default_project.get_option(BLOCKED_METRICS_PROJECT_OPTION_KEY))
    assert len(blocked_metrics) == 0


@django_db_all
def test_get_blocked_metrics(default_project):
    mri_1 = "c:custom/page_click@none"
    mri_2 = "g:custom/page_load@millisecond"

    block_metric(mri_1, [default_project])
    block_tags_of_metric(mri_2, {"release", "environment", "transaction"}, [default_project])

    blocked_metrics = get_blocked_metrics([default_project])[default_project.id]
    assert len(blocked_metrics.metrics) == 2
    assert sorted(blocked_metrics.metrics.values(), key=lambda v: v.metric_mri) == [
        BlockedMetric(metric_mri="c:custom/page_click@none", is_blocked=True, blocked_tags=set()),
        BlockedMetric(
            metric_mri="g:custom/page_load@millisecond",
            is_blocked=False,
            blocked_tags={"environment", "transaction", "release"},
        ),
    ]


@django_db_all
@pytest.mark.parametrize(
    "json_payload",
    [
        "}{",
        "{}",
    ],
)
def test_get_blocked_metrics_with_invalid_payload(default_project, json_payload):
    default_project.update_option(BLOCKED_METRICS_PROJECT_OPTION_KEY, json_payload)

    with pytest.raises(MalformedBlockedMetricsPayloadError):
        get_blocked_metrics([default_project])


@django_db_all
def test_get_blocked_metrics_for_relay_config(default_project):
    mri_1 = "c:custom/page_click@none"
    mri_2 = "g:custom/page_load@millisecond"

    block_metric(mri_1, [default_project])
    block_tags_of_metric(mri_2, {"release", "environment", "transaction"}, [default_project])

    blocked_metrics = get_blocked_metrics_for_relay_config(default_project)
    # For now, no tags are emitted to Relay, thus we expect only the blocked metric to be there.
    assert sorted(blocked_metrics["deniedNames"]) == [
        "c:custom/page_click@none",
    ]