-- Runs once when the Postgres volume is first created.
-- A separate database keeps integration tests away from demo data.
CREATE DATABASE pass_test;
