from unittest import mock
from uuid import uuid4

from django.utils import timezone

from sentry.incidents.action_handlers import generate_incident_trigger_email_context
from sentry.incidents.models.alert_rule import AlertRule, AlertRuleMonitorType, AlertRuleTrigger
from sentry.incidents.models.alert_rule_activations import AlertRuleActivations
from sentry.incidents.models.incident import Incident, IncidentStatus, TriggerStatus
from sentry.incidents.utils.types import AlertRuleActivationConditionType
from sentry.models.organization import Organization
from sentry.models.project import Project
from sentry.models.user import User
from sentry.snuba.models import SnubaQuery

from .mail import MailPreviewView


class MockedIncidentTrigger:
    date_added = timezone.now()


class DebugIncidentActivatedAlertTriggerEmailView(MailPreviewView):
    @mock.patch(
        "sentry.incidents.models.incident.IncidentTrigger.objects.get",
        return_value=MockedIncidentTrigger(),
    )
    @mock.patch("sentry.models.UserOption.objects.get_value", return_value="US/Pacific")
    def get_context(self, request, incident_trigger_mock, user_option_mock):
        organization = Organization(slug="myorg")
        project = Project(slug="myproject", organization=organization)
        user = User()

        query = SnubaQuery(
            time_window=60, query="transaction:/some/transaction", aggregate="count()"
        )
        alert_rule = AlertRule(
            id=1,
            organization=organization,
            name="My Alert",
            snuba_query=query,
            monitor_type=AlertRuleMonitorType.ACTIVATED.value,
        )
        activation = AlertRuleActivations(
            alert_rule=alert_rule,
            condition_type=AlertRuleActivationConditionType.DEPLOY_CREATION.value,
        )
        incident = Incident(
            id=2,
            identifier=123,
            organization=organization,
            title="Something broke",
            alert_rule=alert_rule,
            status=IncidentStatus.CRITICAL.value,
            activation=activation,
        )
        trigger = AlertRuleTrigger(alert_rule=alert_rule)

        return generate_incident_trigger_email_context(
            project,
            incident,
            trigger,
            TriggerStatus.ACTIVE,
            IncidentStatus(incident.status),
            user,
            notification_uuid=str(uuid4()),
        )

    @property
    def html_template(self):
        return "sentry/emails/incidents/trigger.html"

    @property
    def text_template(self):
        return "sentry/emails/incidents/trigger.txt"
