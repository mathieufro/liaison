-- SPDX-License-Identifier: FSL-1.1-ALv2
-- A deal import writes through the run's privileged transaction (liaison_admin) pinned to the
-- run's org with the person's scopes, and creating a deal there asks for its empty value row.
-- The function itself still refuses a context without that org and the tasks:write scope.
-- reviewed-dynamic: a privilege grant, no statement is executed
GRANT EXECUTE ON FUNCTION app_projects.ensure_deal_value(uuid) TO liaison_admin;
