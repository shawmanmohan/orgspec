// Admin policies always win over persona grants.
@id("no-deletes")
forbid(principal, action, resource is OrgSpec::Tool)
when { resource.name like "delete*" };
