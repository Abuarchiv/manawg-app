-- App access is server-owned; global and schema defaults combine in PostgreSQL.
DO $$
DECLARE
	role_name text;
	table_name text;
BEGIN
	FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
		IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
			FOR table_name IN
				SELECT DISTINCT rel.relname
				FROM pg_class rel
			JOIN pg_namespace ns ON ns.oid = rel.relnamespace
			CROSS JOIN LATERAL aclexplode(rel.relacl) acl
			WHERE ns.nspname = 'public'
				AND rel.relkind IN ('r', 'p')
				AND acl.grantee = role_name::regrole::oid
				AND acl.grantor = current_user::regrole::oid
			LOOP
				EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I', table_name, role_name);
			END LOOP;
			EXECUTE format(
				'ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON TABLES FROM %I',
				role_name
			);
			EXECUTE format(
				'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM %I',
				role_name
			);
		END IF;
	END LOOP;
END $$;
