-- name: listMigrations
select name from knex_migrations order by id;

-- name: verifyTable
select count(*) from {{0}};
