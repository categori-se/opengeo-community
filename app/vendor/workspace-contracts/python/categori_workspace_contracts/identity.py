"""Deterministic portable-JSON counterpart of identity.js and collaboration.js.

Applications supply verified identity and current persisted records. This module
does not verify tokens, fetch records, allocate identity, or authorize providers.
All returned records are independent copies. Evaluation time should be supplied
explicitly as a UTC ISO timestamp or datetime; no application namespace is invented.
"""
from copy import deepcopy
from datetime import datetime, timezone
import calendar
import json
import math
import re
from types import MappingProxyType
from urllib.parse import urlsplit, parse_qsl, unquote

identity_schema_version = 1
collaboration_actions = ("view", "comment", "review", "edit", "execute", "use_connection", "manage_access", "delete")
collaboration_role_actions = MappingProxyType({
    "owner": ("view", "comment", "review", "edit", "execute", "manage_access", "delete"),
    "manager": ("view", "comment", "review", "edit", "execute", "manage_access"),
    "editor": ("view", "comment", "review", "edit", "execute"),
    "reviewer": ("view", "comment", "review"), "commenter": ("view", "comment"), "viewer": ("view",),
})
_types = {"workspace", "client", "team", "project", "notebook", "document", "artifact", "repository", "source", "connection"}
_principals = {"user", "team", "workspace", "link", "application", "service_account", "notebook"}
_statuses = {"active", "suspended", "revoked"}
_id = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}")
_utc = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z")
_control = re.compile(r"[\x00-\x1f\x7f]")
_sensitive = re.compile(r"(^|[_-])(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|connection[_-]?string|credential)s?($|[_-])", re.I)
_signed = re.compile(r"(?:x-amz-(?:credential|signature|security-token)|sig|signature|token|access_token|api[_-]?key)", re.I)
_whitespace = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_aliases = {"read":"view", "view_project":"view", "write":"edit", "share":"manage_access", "share_project":"manage_access", "object_read":"view", "object_preview":"view", "object_share":"manage_access", "metadata_edit":"edit"}
_missing = object()


def _issue(path, message):
    return {"path": path, "message": message}


def _object(value):
    return type(value) is dict


def _contains(value, values):
    return type(value) is str and value in values


def _array(value):
    if type(value) is list:
        return value
    return list(value) if type(value) is set else []


def _read(value, *keys):
    if not _object(value):
        return None
    for key in keys:
        if key in value and value[key] is not None:
            return value[key]
    return None


def _truth(value):
    # JavaScript keeps empty arrays/objects truthy.
    if value is None or value is _missing or value is False:
        return False
    if type(value) in (int, float):
        return value != 0 and not (type(value) is float and math.isnan(value))
    return value != ""


def _or(value, other):
    return value if _truth(value) else other


def _string(value):
    if value is None:
        return "null"
    if value is _missing:
        return "undefined"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if type(value) is str:
        return value
    if type(value) is list:
        return ",".join("" if child is None else _string(child) for child in value)
    if _object(value):
        return "[object Object]"
    if type(value) is float and value.is_integer():
        return str(int(value))
    return str(value)


def _number(value):
    if value is None:
        return 0
    if type(value) is bool:
        return int(value)
    if type(value) in (int, float):
        return value
    if type(value) is str:
        try:
            return float(value.strip()) if value.strip() else 0
        except ValueError:
            return float("nan")
    if type(value) is list:
        return _number(_string(value))
    return float("nan")


def _integer(value, safe=False):
    return type(value) in (int, float) and math.isfinite(value) and int(value) == value and (not safe or abs(value) <= 9007199254740991)


def _length(value):
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def _json(value):
    # JSON.stringify emits numeric integral values without a decimal suffix.
    def numbers(item):
        if type(item) is float and item.is_integer():
            return int(item)
        if type(item) is list:
            return [numbers(child) for child in item]
        if _object(item):
            return {key: numbers(child) for key, child in item.items()}
        return item
    text = json.dumps(numbers(value), ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return re.sub(r"[\ud800-\udfff]", lambda match: "\\u%04x" % ord(match[0]), text)


def _portable(value):
    errors, ancestors, count = [], set(), 0
    stack = [(value, "$", 0, False)]
    while stack:
        current, path, depth, exiting = stack.pop()
        if exiting:
            ancestors.remove(id(current))
            continue
        count += 1
        if count > 8192 or depth > 24:
            return [_issue(path, "portable record exceeds structural bounds")]
        if type(current) is str:
            try:
                uri = urlsplit(current)
                if uri.scheme and (uri.username or uri.password or any(_signed.fullmatch(key) for key, _ in parse_qsl(uri.query, keep_blank_values=True))):
                    errors.append(_issue(path, "portable records must not contain credential-bearing or signed URLs"))
            except ValueError:
                pass
            continue
        if current is None or type(current) is bool or type(current) in (int, float) and math.isfinite(current):
            continue
        if type(current) not in (dict, list):
            errors.append(_issue(path, "portable values must be JSON data"))
            continue
        if id(current) in ancestors:
            errors.append(_issue(path, "portable values must not contain cycles"))
            continue
        ancestors.add(id(current))
        stack.append((current, path, depth, True))
        for key, child in (current.items() if _object(current) else enumerate(current)):
            if type(key) not in (str, int):
                errors.append(_issue(path, "portable values must be JSON data"))
                continue
            child_path = f"{path}.{key}"
            if _sensitive.search(str(key)) or re.search(r"(?:^|:)(?:password|token|secret|api_key|access_key|private_key)$", str(key), re.I):
                errors.append(_issue(child_path, "portable records must not contain credentials or secrets"))
            stack.append((child, child_path, depth + 1, False))
    if not errors and len(_json(value).encode("utf-8", "surrogatepass")) > 65536:
        errors.append(_issue("$", "portable record exceeds the 64 KiB UTF-8 bound"))
    return errors


def _issuer(value):
    if type(value) is not str or _length(value) > 500 or any(char in _whitespace for char in value):
        return False
    try:
        scheme = re.match(r"https:(.*)",value,re.I | re.ASCII)
        if not scheme:
            return False
        parsed = urlsplit("https://" + scheme[1].replace("\\","/").lstrip("/"))
        host = unquote(parsed.hostname or "")
        parsed.port  # WHATWG URL rejects malformed and out-of-range ports.
        if not host or re.search(r"[\x00-\x20\x7f/#?@\\]",host):
            return False
        return not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
    except ValueError:
        return False


def _subject(value):
    return type(value) is str and 0 < _length(value) <= 512 and value.strip(_whitespace) == value and not _control.search(value)


def _days(year, month, day):
    # Proleptic Gregorian arithmetic includes year zero, accepted by ECMAScript.
    year -= month <= 2
    era = year // 400
    yoe = year - era * 400
    doy = (153 * (month + (-3 if month > 2 else 9)) + 2) // 5 + day - 1
    return era * 146097 + yoe * 365 + yoe // 4 - yoe // 100 + doy - 719468


def _time(value):
    """ECMAScript ISO date/time forms used by portable records, in milliseconds."""
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc).timestamp() * 1000 if value.tzinfo is None else value.timestamp() * 1000
    if value is None:
        return 0
    if type(value) in (int, float, bool):
        return float(value) if math.isfinite(value) and abs(value) <= 8640000000000000 else float("nan")
    if type(value) is not str:
        return float("nan")
    try:
        # Date.parse accepts ISO calendar overflow (e.g. February 30); identity
        # timestamp validation below separately requires an exact UTC roundtrip.
        match = re.fullmatch(r"([0-9]{4}|[+-][0-9]{6})-([0-9]{2})-([0-9]{2})(?:T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?", value)
        if match:
            year, month, day = map(int, match.group(1, 2, 3))
            hour, minute, second = [int(item or 0) for item in match.group(4, 5, 6)]
            millis = int((match.group(7) or "0").ljust(3,"0")[:3])
            if not 1 <= month <= 12 or not 1 <= day <= 31 or hour > 24 or minute > 59 or second > 59 or hour == 24 and (minute or second or millis):
                return float("nan")
            moment = _days(year,month,day) * 86400000 + hour * 3600000 + minute * 60000 + second * 1000 + millis
            offset = match.group(8)
            if offset and offset != "Z":
                digits = offset[1:].replace(":", "")
                oh, om = int(digits[:2]), int(digits[2:])
                if oh > 23 or om > 59:
                    return float("nan")
                moment -= (oh * 60 + om) * (1 if offset[0] == "+" else -1) * 60000
            return moment if abs(moment) <= 8640000000000000 else float("nan")
        return float("nan")
    except (ValueError, OverflowError):
        return float("nan")


def _timestamp(value):
    if type(value) is not str or not _utc.fullmatch(value):
        return False
    year, month, day = int(value[:4]), int(value[5:7]), int(value[8:10])
    hour, minute, second = int(value[11:13]), int(value[14:16]), int(value[17:19])
    return 1 <= month <= 12 and 1 <= day <= calendar.monthrange(year,month)[1] and hour <= 23 and minute <= 59 and second <= 59


def _fields(value, names, errors, path="$"):
    for key in value:
        if key not in names:
            errors.append(_issue(f"{path}.{key}", "unsupported field"))


def _base(value, names):
    if not _object(value):
        return [_issue("$", "must be a plain object")]
    errors = _portable(value)
    if errors:
        return errors
    _fields(value, names, errors)
    if type(value.get("schema_version")) is bool or value.get("schema_version") != 1:
        errors.append(_issue("$.schema_version", "unsupported identity schema"))
    if not _contains(value.get("status"), _statuses):
        errors.append(_issue("$.status", "must be active, suspended, or revoked"))
    if not _integer(value.get("revision"), safe=True) or value["revision"] < 1:
        errors.append(_issue("$.revision", "must be a positive safe integer"))
    return errors


def _identifier(value, key, errors):
    if type(value.get(key)) is not str or not _id.fullmatch(value[key]):
        errors.append(_issue(f"$.{key}", "must be an opaque identifier"))


def validate_external_identity_link(value):
    errors = _base(value, {"schema_version", "link_id", "issuer", "subject", "user_id", "status", "revision", "verified_at"})
    if not _object(value):
        return errors
    for key in ("link_id", "user_id"):
        _identifier(value, key, errors)
    if not _issuer(value.get("issuer")):
        errors.append(_issue("$.issuer", "must be an exact credential-free HTTPS issuer"))
    if not _subject(value.get("subject")):
        errors.append(_issue("$.subject", "must be a bounded exact subject"))
    if not _timestamp(value.get("verified_at")):
        errors.append(_issue("$.verified_at", "must record a valid UTC verification timestamp"))
    return errors


def validate_identity_user(value):
    errors = _base(value, {"schema_version", "user_id", "status", "revision"})
    if _object(value):
        _identifier(value, "user_id", errors)
    return errors


def validate_identity_workspace(value):
    errors = _base(value, {"schema_version", "workspace_id", "status", "revision"})
    if _object(value):
        _identifier(value, "workspace_id", errors)
    return errors


def validate_workspace_participation(value):
    errors = _base(value, {"schema_version", "participation_id", "workspace_id", "user_id", "mode", "status", "revision", "resource_scopes", "not_before", "expires_at"})
    if not _object(value):
        return errors
    for key in ("participation_id", "workspace_id", "user_id"):
        _identifier(value, key, errors)
    if value.get("mode") not in ("member", "guest"):
        errors.append(_issue("$.mode", "must be member or guest"))
    scopes = value.get("resource_scopes")
    if type(scopes) is not list or len(scopes) > 256:
        errors.append(_issue("$.resource_scopes", "must contain at most 256 explicit resource scopes"))
    else:
        seen = set()
        for index, scope in enumerate(scopes):
            path = f"$.resource_scopes[{index}]"
            if not _object(scope):
                errors.append(_issue(path, "must be a plain object"))
                continue
            _fields(scope, {"resource_type", "resource_id"}, errors, path)
            for key in ("resource_type", "resource_id"):
                if type(scope.get(key)) is not str or not _id.fullmatch(scope[key]):
                    errors.append(_issue(f"{path}.{key}", "must be an exact opaque identifier"))
            pair = _json([scope.get("resource_type"), scope.get("resource_id")])
            if pair in seen:
                errors.append(_issue(path, "duplicate resource scope"))
            seen.add(pair)
        if value.get("mode") == "guest" and not scopes:
            errors.append(_issue("$.resource_scopes", "guests require at least one explicit resource scope"))
        if value.get("mode") == "member" and scopes:
            errors.append(_issue("$.resource_scopes", "member participation cannot carry guest scopes"))
    for key in ("not_before", "expires_at"):
        if value.get(key, _missing) is not None and not _timestamp(value.get(key)):
            errors.append(_issue(f"$.{key}", "must be null or a valid UTC timestamp"))
    if _timestamp(value.get("not_before")) and _timestamp(value.get("expires_at")) and _time(value["not_before"]) >= _time(value["expires_at"]):
        errors.append(_issue("$.expires_at", "must be later than not_before"))
    return errors


def external_identity_key(value=None, **kwargs):
    value = dict(value or {}, **kwargs)
    if not _issuer(value.get("issuer")) or not _subject(value.get("subject")):
        raise TypeError("Exact verified issuer and subject are required")
    return _json([value["issuer"], value["subject"]])


def _options(options, kwargs):
    return dict(options or {}, **kwargs)


def resolve_identity_user(options=None, **kwargs):
    options = _options(options, kwargs)
    def denied(reason):
        return {"schema_version":1, "allowed":False, "reason":reason, "user_id":None, "link_id":None, "principal":None}
    verified = options.get("verifiedIdentity")
    if not _object(verified) or set(verified) - {"issuer", "subject"} or not _issuer(verified.get("issuer")) or not _subject(verified.get("subject")):
        return denied("invalid_verified_identity")
    links, users = options.get("identityLinks", []), options.get("users", [])
    if type(links) is not list or len(links) > 4096 or type(users) is not list or len(users) > 4096 or any(validate_external_identity_link(link) for link in links) or any(validate_identity_user(user) for user in users):
        return denied("invalid_identity_records")
    matches = [link for link in links if link["issuer"] == verified["issuer"] and link["subject"] == verified["subject"]]
    if len(matches) != 1:
        return denied("ambiguous_identity_link" if matches else "identity_not_linked")
    link = matches[0]
    if link["status"] != "active":
        return denied("identity_link_" + link["status"])
    matches = [user for user in users if user["user_id"] == link["user_id"]]
    if len(matches) != 1:
        return denied("ambiguous_user" if matches else "user_not_found")
    user = matches[0]
    if user["status"] != "active":
        return denied("user_" + user["status"])
    return {"schema_version":1, "allowed":True, "reason":"active", "user_id":user["user_id"], "link_id":link["link_id"], "principal":{"principal_type":"user", "principal_id":user["user_id"]}}


def actions_for_collaboration_role(role):
    return list(collaboration_role_actions.get(role, ())) if type(role) is str else []


def normalize_collaboration_actions(values=None):
    normalized = set()
    for raw in _array(values):
        value = _string(_or(raw, "")).strip(_whitespace)
        if value in collaboration_role_actions:
            normalized.update(collaboration_role_actions[value])
        else:
            action = _aliases.get(value, _aliases.get(value.replace(".", "_"), value))
            if action in collaboration_actions:
                normalized.add(action)
    return [action for action in collaboration_actions if action in normalized]


def _canonical_resource(resource):
    policy = _or(_read(resource, "access_policy", "accessPolicy"), {})
    kind = _or(_read(resource, "resource_type", "resourceType", "type"), "notebook" if _truth(_read(resource, "notebook_id", "notebookId")) else "")
    camel = re.sub(r"_([a-z])", lambda match:match[1].upper(), _string(kind))
    number = _read(resource, "schema_version", "schemaVersion")
    result = deepcopy(resource) if _object(resource) else {}
    result.update({"schema_version":_number(1 if number is None else number), "resource_type":kind,
        "resource_id":_or(_or(_read(resource, "resource_id", "resourceId"), _read(resource, f"{kind}_id", f"{camel}Id", "id")), ""),
        "workspace_id":_or(_read(resource, "workspace_id", "workspaceId", "tenant_id", "tenantId"), ""),
        "access_policy":{"inheritance":_or(_read(policy, "inheritance"), "restricted"), "allow_public_links":_read(policy, "allow_public_links", "allowPublicLinks") is True}})
    for field, aliases in {"project_id":("project_id","projectId"), "client_id":("client_id","clientId"), "team_id":("team_id","teamId")}.items():
        result[field] = _or(_read(resource,*aliases),None)
    result["creator_id"] = _read(resource,"creator_id","creatorId","created_by","createdBy")
    owner = _read(resource,"owner_id","ownerId","owner_user_id","ownerUserId")
    result["owner_id"] = result["creator_id"] if owner is None else owner
    return result


def _canonical_grant(grant):
    result = deepcopy(grant) if _object(grant) else {}
    aliases = {
        "grant_id":("grant_id","grantId","id"), "resource_type":("resource_type","resourceType"), "resource_id":("resource_id","resourceId"),
        "workspace_id":("workspace_id","workspaceId","tenant_id","tenantId"), "subject_type":("subject_type","subjectType","principal_type","principalType","target_type","targetType"),
        "subject_id":("subject_id","subjectId","principal_id","principalId","target_id","targetId"), "role":("role",), "effect":("effect",), "status":("status",),
        "not_before":("not_before","notBefore"), "expires_at":("expires_at","expiresAt"), "conditions":("conditions",),
    }
    defaults = {"role":None,"effect":"allow","status":"active","not_before":None,"expires_at":None,"conditions":{}}
    for field, keys in aliases.items():
        result[field] = deepcopy(_or(_read(grant,*keys),defaults.get(field,"")))
    number = _read(grant,"schema_version","schemaVersion")
    result["schema_version"] = _number(1 if number is None else number)
    result["revision"] = _number(_or(_read(grant,"revision","version"),1))
    result["actions"] = deepcopy(_array(_read(grant,"actions","permissions")))
    return result


def _collaboration_id(value, path, errors):
    if not _id.fullmatch(_string(_or(value,""))):
        errors.append(_issue(path,"must be a non-empty opaque identifier"))


def validate_collaboration_resource(resource):
    value, errors = _canonical_resource(resource), []
    if not _object(resource):
        return [_issue("$","resource must be an object")]
    if value["schema_version"] != 1:
        errors.append(_issue("$.schema_version","schema_version must be 1"))
    if not _contains(value["resource_type"], _types):
        errors.append(_issue("$.resource_type","resource_type is not supported"))
    for key in ("resource_id","workspace_id"):
        _collaboration_id(value[key],f"$.{key}",errors)
    for key in ("project_id","client_id","team_id"):
        if _truth(value[key]):
            _collaboration_id(value[key],f"$.{key}",errors)
    for key in ("creator_id","owner_id"):
        if value[key] is not None:
            _collaboration_id(value[key],f"$.{key}",errors)
    if value["access_policy"]["inheritance"] not in ("inherit","restricted"):
        errors.append(_issue("$.access_policy.inheritance","inheritance must be inherit or restricted"))
    if value["resource_type"] == "notebook":
        for key in ("project_id","owner_id"):
            if not _truth(value[key]):
                errors.append(_issue(f"$.{key}",f"notebook resources require {key}"))
    return errors


def _actions_from_grant(grant):
    return normalize_collaboration_actions(([grant["role"]] if _truth(grant["role"]) else []) + _array(grant["actions"]))


def validate_resource_grant(grant, options=None, *, resource=None):
    if options is not None:
        resource = options.get("resource",resource)
    value, errors = _canonical_grant(grant), []
    if not _object(grant):
        return [_issue("$","grant must be an object")]
    if value["schema_version"] != 1:
        errors.append(_issue("$.schema_version","schema_version must be 1"))
    _collaboration_id(value["grant_id"],"$.grant_id",errors)
    if not _contains(value["resource_type"], _types):
        errors.append(_issue("$.resource_type","resource_type is not supported"))
    for key in ("resource_id","workspace_id"):
        _collaboration_id(value[key],f"$.{key}",errors)
    if not _contains(value["subject_type"], _principals):
        errors.append(_issue("$.subject_type","subject_type is not supported"))
    _collaboration_id(value["subject_id"],"$.subject_id",errors)
    if value["effect"] not in ("allow","deny"):
        errors.append(_issue("$.effect","effect must be allow or deny"))
    if value["status"] not in ("pending","active","revoked"):
        errors.append(_issue("$.status","status is not supported"))
    if _truth(value["role"]) and not _contains(value["role"], collaboration_role_actions):
        errors.append(_issue("$.role","role is not supported"))
    for action in _array(_read(grant,"actions","permissions")):
        text = _string(_or(action,"")).strip(_whitespace)
        normalized = _aliases.get(text,_aliases.get(text.replace(".","_"),text))
        if normalized not in collaboration_actions and text not in collaboration_role_actions:
            errors.append(_issue("$.actions",f"unsupported action: {text or '(empty)'}"))
    actions = _actions_from_grant(value)
    if not actions:
        errors.append(_issue("$.actions","a role or at least one action is required"))
    if value["subject_type"] == "link":
        if value["effect"] != "allow":
            errors.append(_issue("$.effect","link grants can only allow access"))
        if any(action not in ("view","comment","review") for action in actions):
            errors.append(_issue("$.actions","link grants are limited to view, comment, and review"))
    if value["role"] == "owner" and (value["effect"] != "allow" or value["subject_type"] != "user"):
        errors.append(_issue("$.role","owner is an allow-only user role"))
    for key in ("not_before","expires_at"):
        if _truth(value[key]) and not math.isfinite(_time(value[key])):
            errors.append(_issue(f"$.{key}","must be an ISO timestamp"))
    if _truth(value["not_before"]) and _truth(value["expires_at"]) and _time(value["not_before"]) >= _time(value["expires_at"]):
        errors.append(_issue("$.expires_at","expires_at must be later than not_before"))
    if not _integer(value["revision"]) or value["revision"] < 1:
        errors.append(_issue("$.revision","revision must be a positive integer"))
    conditions = value["conditions"]
    if not _object(conditions):
        errors.append(_issue("$.conditions","conditions must be an object"))
    else:
        for key in conditions:
            if key not in ("require_mfa","approval_id","require_reference_write"):
                errors.append(_issue(f"$.conditions.{key}","condition is not supported by the shared evaluator"))
        for key in ("require_mfa","require_reference_write"):
            if key in conditions and type(conditions[key]) is not bool:
                errors.append(_issue(f"$.conditions.{key}",f"{key} must be boolean"))
        if conditions.get("approval_id") is not None and not _id.fullmatch(_string(conditions["approval_id"])):
            errors.append(_issue("$.conditions.approval_id","approval_id must be an opaque identifier"))
    if _truth(resource):
        target = _canonical_resource(resource)
        for key, message in (("resource_type","grant resource_type does not match the resource"),("resource_id","grant resource_id does not match the resource"),("workspace_id","grant crosses the resource workspace boundary")):
            if value[key] != target[key]:
                errors.append(_issue(f"$.{key}",message))
        if value["effect"] == "deny" and value["subject_type"] == "user" and value["subject_id"] == target["owner_id"]:
            errors.append(_issue("$.subject_id","ordinary grants cannot deny the resource owner"))
    return errors


def _membership_matches(member, principal_id, workspace_id, team_id=None):
    if not _object(member) or _string(_or(_read(member,"principal_id","principalId","user_id","userId","member_id","memberId"),"")) != _string(principal_id):
        return False
    if _string(_or(_read(member,"status"),"")).lower() not in ("active","accepted"):
        return False
    scope = _read(member,"workspace_id","workspaceId","account_id","accountId","tenant_id","tenantId")
    if _truth(scope) and _string(scope) != _string(workspace_id):
        return False
    actual = _read(member,"team_id","teamId")
    return _string(_or(actual,"")) == _string(team_id) if team_id else not _truth(actual)


def _grant_subject(grant, principal, resource, memberships):
    if grant["subject_type"] == principal["principal_type"] and grant["subject_id"] == principal["principal_id"]:
        return True
    if principal["principal_type"] != "user":
        return False
    if grant["subject_type"] == "team":
        return any(_membership_matches(row,principal["principal_id"],resource["workspace_id"],grant["subject_id"]) for row in _array(memberships))
    if grant["subject_type"] == "workspace" and grant["subject_id"] == resource["workspace_id"]:
        return any(_membership_matches(row,principal["principal_id"],resource["workspace_id"]) for row in _array(memberships))
    return False


def _inactive(grant, now, context):
    if grant["status"] != "active":
        return "revoked" if grant["status"] == "revoked" else "inactive"
    instant = _time(now)
    if _truth(grant["not_before"]) and instant < _time(grant["not_before"]):
        return "not_started"
    if _truth(grant["expires_at"]) and instant >= _time(grant["expires_at"]):
        return "expired"
    conditions = grant["conditions"]
    if conditions.get("require_mfa") is True and context.get("mfa") is not True:
        return "mfa_required"
    if _truth(conditions.get("approval_id")) and conditions["approval_id"] not in _array(_read(context,"approval_ids","approvalIds")):
        return "approval_required"
    if conditions.get("require_reference_write") is True and _read(context,"reference_written","referenceWritten") is not True:
        return "reference_write_required"
    return None


def resolve_resource_access(options=None, **kwargs):
    options = _options(options,kwargs)
    raw_resource, raw_principal = options.get("resource"), options.get("principal")
    resource = _canonical_resource(raw_resource)
    errors = validate_collaboration_resource(raw_resource)
    principal = {"principal_type":_or(_read(raw_principal,"principal_type","principalType","type"),"user" if _truth(_read(raw_principal,"user_id","userId")) else ""),
        "principal_id":_or(_read(raw_principal,"principal_id","principalId","user_id","userId","id","sub"),"")}
    result = {"schema_version":1,"resource_type":_or(resource["resource_type"],None),"resource_id":_or(resource["resource_id"],None),
        "principal_type":_or(principal["principal_type"],None),"principal_id":_or(principal["principal_id"],None),"allowed_actions":[],"denied_actions":[],"owner":False,"inherited":False,"valid":False,"issues":[],"provenance":{},"grant_evaluations":[]}
    if errors or not _contains(principal["principal_type"], _principals) or not _truth(principal["principal_id"]):
        result["issues"] = errors or [_issue("$.principal","principal type and id are required")]
        return deepcopy(result)
    allows, denies = {}, {}
    owner = principal["principal_type"] == "user" and principal["principal_id"] == resource["owner_id"]
    def source(target, action, kind, identifier):
        target.setdefault(action,[]).append({"source_type":kind,"source_id":identifier})
    if owner:
        for action in collaboration_role_actions["owner"]:
            source(allows,action,"ownership",resource["owner_id"])
    inherited = []
    if resource["access_policy"]["inheritance"] == "inherit":
        parent = options.get("parentAccess",[])
        inherited = normalize_collaboration_actions(_or(_read(parent,"allowed_actions","allowedActions"),parent))
        for action in inherited:
            source(allows,action,"parent",_or(resource["project_id"],resource["workspace_id"]))
    evaluations = []
    now = options.get("now",datetime.now(timezone.utc))
    context = options.get("context",{})
    for raw_grant in _array(options.get("grants",[])):
        grant = _canonical_grant(raw_grant)
        issues = validate_resource_grant(raw_grant,resource=resource)
        row = {"grant_id":_or(grant["grant_id"],None),"applicable":False,"reason":"invalid"}
        if issues:
            row["issues"] = issues
        else:
            reason = _inactive(grant,now,context)
            if reason:
                row["reason"] = reason
            elif not _grant_subject(grant,principal,resource,options.get("memberships",[])):
                row["reason"] = "subject_mismatch"
            elif grant["subject_type"] == "link" and resource["access_policy"]["allow_public_links"] is not True:
                row["reason"] = "public_links_disabled"
            else:
                target = denies if grant["effect"] == "deny" else allows
                for action in _actions_from_grant(grant):
                    source(target,action,"grant",grant["grant_id"])
                row.update(applicable=True,reason=grant["effect"])
        evaluations.append(row)
    denied = [] if owner else [action for action in collaboration_actions if action in denies]
    result.update(valid=True,issues=[],owner=owner,inherited=bool(inherited),denied_actions=denied,
        allowed_actions=[action for action in collaboration_actions if action in allows and action not in denied],grant_evaluations=evaluations,
        provenance={action:{"allowed_by":allows.get(action,[]),"denied_by":denies.get(action,[])} for action in collaboration_actions if action in allows or action in denies})
    return deepcopy(result)


def resolve_scoped_resource_access(options=None, **kwargs):
    options = _options(options,kwargs)
    identity = resolve_identity_user(options)
    def denied(reason):
        return {"schema_version":1,"valid":False,"reason":reason,"identity":identity,"participation_id":None,"mode":None,"allowed_actions":[],"access":None}
    if not identity["allowed"]:
        return denied(identity["reason"])
    workspace = options.get("workspace")
    if validate_identity_workspace(workspace):
        return denied("invalid_workspace")
    if workspace["status"] != "active":
        return denied("workspace_" + workspace["status"])
    raw_resource = options.get("resource")
    if validate_collaboration_resource(raw_resource):
        return denied("invalid_resource")
    resource = _canonical_resource(raw_resource)
    if resource["workspace_id"] != workspace["workspace_id"]:
        return denied("resource_workspace_mismatch")
    now = options.get("now",datetime.now(timezone.utc))
    instant = _time(now)
    if not math.isfinite(instant):
        return denied("invalid_time")
    participations = options.get("participations",[])
    if type(participations) is not list or len(participations) > 4096 or any(validate_workspace_participation(record) for record in participations):
        return denied("invalid_participation_records")
    if len({record["participation_id"] for record in participations}) != len(participations):
        return denied("ambiguous_participation")
    applicable = [record for record in participations if record["user_id"] == identity["user_id"] and record["workspace_id"] == workspace["workspace_id"] and record["status"] == "active" and (record["not_before"] is None or instant >= _time(record["not_before"])) and (record["expires_at"] is None or instant < _time(record["expires_at"]))]
    participation = next((record for record in applicable if record["mode"] == "member"),None)
    if participation is None:
        participation = next((record for record in applicable if record["mode"] == "guest" and any(scope["resource_type"] == resource["resource_type"] and scope["resource_id"] == resource["resource_id"] for scope in record["resource_scopes"])),None)
    if participation is None:
        return denied("no_active_scoped_participation")
    grants, memberships = options.get("grants",[]), options.get("memberships",[])
    if type(grants) is not list or type(memberships) is not list:
        return denied("invalid_access_records")
    guest = participation["mode"] == "guest"
    access = resolve_resource_access({"principal":identity["principal"],"resource":resource,
        "grants":[grant for grant in grants if _object(grant) and grant.get("subject_type") == "user" and grant.get("subject_id") == identity["user_id"]] if guest else grants,
        "memberships":[] if guest else memberships,"parentAccess":[] if guest else options.get("parentAccess",[]),"context":options.get("context",{}),"now":now})
    return {"schema_version":1,"valid":access["valid"],"reason":"evaluated","identity":identity,"participation_id":participation["participation_id"],"mode":participation["mode"],"allowed_actions":deepcopy(access["allowed_actions"]),"access":access}


def authorize_scoped_resource(options, action):
    return action in collaboration_actions and action in resolve_scoped_resource_access(options)["allowed_actions"]


def authorize_resource(options, action):
    normalized = normalize_collaboration_actions([action])
    return len(normalized) == 1 and normalized[0] in resolve_resource_access(options)["allowed_actions"]


def _assert(value, validator):
    errors = validator(value)
    if errors:
        raise TypeError("; ".join(f"{row['path']}: {row['message']}" for row in errors))
    return deepcopy(value)


def create_identity_user(*, user_id, status="active", revision=1):
    return _assert({"schema_version":1,"user_id":user_id,"status":status,"revision":revision},validate_identity_user)


def create_identity_workspace(*, workspace_id, status="active", revision=1):
    return _assert({"schema_version":1,"workspace_id":workspace_id,"status":status,"revision":revision},validate_identity_workspace)


def create_external_identity_link(*, link_id, issuer, subject, user_id, verified_at, status="active", revision=1):
    return _assert({"schema_version":1,"link_id":link_id,"issuer":issuer,"subject":subject,"user_id":user_id,"verified_at":verified_at,"status":status,"revision":revision},validate_external_identity_link)


def create_workspace_participation(*, participation_id, workspace_id, user_id, mode="member", status="active", revision=1, resource_scopes=None, not_before=None, expires_at=None):
    return _assert({"schema_version":1,"participation_id":participation_id,"workspace_id":workspace_id,"user_id":user_id,"mode":mode,"status":status,"revision":revision,"resource_scopes":[] if resource_scopes is None else resource_scopes,"not_before":not_before,"expires_at":expires_at},validate_workspace_participation)


def assert_collaboration_resource(value):
    _assert(value,validate_collaboration_resource)
    return deepcopy(_canonical_resource(value))


def assert_resource_grant(value, options=None, *, resource=None):
    if options:
        resource = options.get("resource",resource)
    _assert(value,lambda record:validate_resource_grant(record,resource=resource))
    return deepcopy(_canonical_grant(value))
