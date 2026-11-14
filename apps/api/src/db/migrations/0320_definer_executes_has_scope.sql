-- SPDX-License-Identifier: FSL-1.1-ALv2
-- kernel.can_manage_company_sharing (0291) runs as liaison_definer and calls kernel.has_scope.
-- Where the read-only role's grants have taken EXECUTE on kernel's functions away from PUBLIC
-- (a deployed instance), liaison_definer could no longer call it, so reading or changing a
-- company's sharing failed. This grants it explicitly. Only adds a privilege: the previous
-- release runs unchanged.
-- reviewed-dynamic: a privilege grant, no statement is executed
GRANT EXECUTE ON FUNCTION kernel.has_scope(text) TO liaison_definer;
