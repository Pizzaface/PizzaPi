import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .createTable("jwt_keys")
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("public_key", "text", (col) => col.notNull())
        .addColumn("private_key", "text", (col) => col.notNull())
        .addColumn("active", "integer", (col) => col.notNull().defaultTo(1))
        .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
    await db.schema.dropTable("jwt_keys").ifExists().execute();
}
