import uuid


def get_header_relay_id(request):
    try:
        return str(uuid.UUID(request.META["HTTP_X_SENTRY_RELAY_ID"]))
    except (LookupError, ValueError, TypeError):
        pass


def get_header_relay_signature(request):
    try:
        return str(request.META["HTTP_X_SENTRY_RELAY_SIGNATURE"])
    except (LookupError, ValueError, TypeError):
        pass


def type_to_class_name(snake_str):
    components = snake_str.split("_")
    return "".join(x.title() for x in components[0:])
def to_camel_case_name(name):
    """
    Converts a string from snake_case to camelCase

    :param name: the string to convert
    :return: the name converted to camelCase

    >>> to_camel_case_name(22)
    22
    >>> to_camel_case_name("hello_world")
    'helloWorld'
    >>> to_camel_case_name("_hello_world")
    'helloWorld'
    >>> to_camel_case_name("__hello___world___")
    'helloWorld'
    >>> to_camel_case_name("hello")
    'hello'
    >>> to_camel_case_name("Hello_world")
    'helloWorld'
    >>> to_camel_case_name("one_two_three_four")
    'oneTwoThreeFour'
    >>> to_camel_case_name("oneTwoThreeFour")
    'oneTwoThreeFour'
    """

    if not isinstance(name, str):
        return name

    name = name.strip("_")
    if not name:
        return ""

    pieces = name.split("_")
    if len(pieces) == 1:
        return pieces[0][0].lower() + pieces[0][1:]

    result = [pieces[0][0].lower() + pieces[0][1:]]
    for piece in pieces[1:]:
        if piece:
            result.append(piece[0].upper() + piece[1:])

    return "".join(result)
