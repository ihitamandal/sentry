from django import forms
from django.forms.utils import ErrorList
from django.utils.encoding import force_str
from django.utils.translation import gettext_lazy as _
from onelogin.saml2.idp_metadata_parser import OneLogin_Saml2_IdPMetadataParser
from requests.exceptions import SSLError

from sentry.http import safe_urlopen


def extract_idp_data_from_parsed_data(data):
    """
    Transform data returned by the OneLogin_Saml2_IdPMetadataParser into the
    expected IdP dict shape.
    """
    idp = data.get("idp")
    if not idp:
        return {
            "entity_id": None,
            "sso_url": None,
            "slo_url": None,
            "x509cert": None,
        }

    single_sign_on_service = idp.get("singleSignOnService")
    single_logout_service = idp.get("singleLogoutService")
    x509cert = idp.get("x509cert")

    if not x509cert:
        x509cert_multi = idp.get("x509certMulti")
        if x509cert_multi:
            x509cert = x509cert_multi.get("signing", [None])[0]
    
    return {
        "entity_id": idp.get("entityId"),
        "sso_url": single_sign_on_service["url"] if single_sign_on_service else None,
        "slo_url": single_logout_service["url"] if single_logout_service else None,
        "x509cert": x509cert,
    }


def process_url(form):
    url = form.cleaned_data["metadata_url"]
    response = safe_urlopen(url)
    data = OneLogin_Saml2_IdPMetadataParser.parse(response.content)
    return extract_idp_data_from_parsed_data(data)


def process_xml(form):
    # cast unicode xml to byte string so lxml won't complain when trying to
    # parse a xml document with a type declaration.
    xml = form.cleaned_data["metadata_xml"].encode("utf8")
    data = OneLogin_Saml2_IdPMetadataParser.parse(xml)
    return extract_idp_data_from_parsed_data(data)


class URLMetadataForm(forms.Form):
    metadata_url = forms.URLField(label="Metadata URL", assume_scheme="https")
    processor = process_url


class XMLMetadataForm(forms.Form):
    metadata_xml = forms.CharField(label="Metadata XML", widget=forms.Textarea)
    processor = process_xml


class SAMLForm(forms.Form):
    entity_id = forms.CharField(label="Entity ID")
    sso_url = forms.URLField(label="Single Sign On URL", assume_scheme="https")
    slo_url = forms.URLField(label="Single Log Out URL", required=False, assume_scheme="https")
    x509cert = forms.CharField(label="x509 public certificate", widget=forms.Textarea)
    processor = lambda d: d.cleaned_data


def process_metadata(form_cls, request, helper):
    form = form_cls()

    if "action_save" not in request.POST:
        return form

    form = form_cls(request.POST)

    if not form.is_valid():
        return form

    try:
        data = form_cls.processor(form)
    except SSLError:
        errors = form._errors.setdefault("__all__", ErrorList())
        errors.append(
            "Could not verify SSL certificate. Ensure that your IdP instance has a valid SSL certificate that is linked to a trusted root certificate."
        )
        return form
    except Exception:
        errors = form._errors.setdefault("__all__", ErrorList())
        errors.append("Failed to parse provided SAML2 metadata")
        return form

    saml_form = SAMLForm(data)
    if not saml_form.is_valid():
        field_errors = [
            "{}: {}".format(k, ", ".join(force_str(i) for i in v))
            for k, v in saml_form.errors.items()
        ]
        error_list = ", ".join(field_errors)

        errors = form._errors.setdefault("__all__", ErrorList())
        errors.append(f"Invalid metadata: {error_list}")
        return form

    helper.bind_state("idp", data)

    # Data is bound, do not respond with a form to signal the next steps
    return None


class AttributeMappingForm(forms.Form):
    # NOTE: These fields explicitly map to the sentry.auth.saml2.Attributes keys
    identifier = forms.CharField(
        label="IdP User ID",
        widget=forms.TextInput(attrs={"placeholder": "eg. user.uniqueID"}),
        help_text=_(
            "The IdPs unique ID attribute key for the user. This is "
            "what Sentry will used to identify the users identity from "
            "the identity provider."
        ),
    )
    user_email = forms.CharField(
        label="User Email",
        widget=forms.TextInput(attrs={"placeholder": "eg. user.email"}),
        help_text=_(
            "The IdPs email address attribute key for the "
            "user. Upon initial linking this will be used to identify "
            "the user in Sentry."
        ),
    )
    first_name = forms.CharField(label="First Name", required=False)
    last_name = forms.CharField(label="Last Name", required=False)
