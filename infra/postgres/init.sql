-- Runs once when the local Postgres volume is first created.
-- A separate database for automated tests so `pnpm test` never touches dev data.
CREATE DATABASE videochat_test OWNER videochat;
