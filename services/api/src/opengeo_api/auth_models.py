from dataclasses import dataclass
from typing import Literal
from uuid import UUID

OrganizationRole = Literal["admin", "member", "guest"]


@dataclass(frozen=True, slots=True)
class VerifiedAccessToken:
    subject: str
    client_id: str
    username: str | None
    scopes: tuple[str, ...]
    groups: tuple[str, ...]
    audiences: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class OrganizationMembership:
    organization_id: UUID
    role: OrganizationRole


@dataclass(frozen=True, slots=True)
class Principal:
    user_id: UUID
    subject: str
    email: str
    display_name: str
    memberships: tuple[OrganizationMembership, ...]


@dataclass(frozen=True, slots=True)
class AuthSession:
    principal: Principal
    selected_membership: OrganizationMembership | None
