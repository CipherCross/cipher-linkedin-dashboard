\set ON_ERROR_STOP on

-- Test-only login roles for the post-restore behavioural assertions.
--
-- app_system and app_readonly are NOLOGIN in the real contract, so the harness
-- needs a way to reach them from an actual session. Both clients are NOINHERIT,
-- so an assertion must SET ROLE explicitly and cannot accidentally borrow
-- another principal's privileges. Neither role is part of the portable
-- artifacts or the production role contract, and neither has a credential.

CREATE ROLE app_ai_client
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT LOGIN NOREPLICATION NOBYPASSRLS;
GRANT app_system TO app_ai_client;

CREATE ROLE app_readonly_client
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT LOGIN NOREPLICATION NOBYPASSRLS;
GRANT app_readonly TO app_readonly_client;
