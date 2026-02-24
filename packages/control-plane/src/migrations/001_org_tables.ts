import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .createTable("organizations")
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("slug", "text", (col) => col.notNull().unique())
        .addColumn("name", "text", (col) => col.notNull())
        .addColumn("status", "text", (col) => col.notNull().defaultTo("active"))
        .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
        .addColumn("updated_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createTable("org_memberships")
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("user_id", "text", (col) => col.notNull().references("user.id"))
        .addColumn("org_id", "text", (col) => col.notNull().references("organizations.id"))
        .addColumn("role", "text", (col) => col.notNull())
        .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex("idx_org_memberships_user")
        .on("org_memberships")
        .column("user_id")
        .execute();

    await db.schema
        .createIndex("idx_org_memberships_org")
        .on("org_memberships")
        .column("org_id")
        .execute();

    await db.schema
        .createIndex("idx_org_memberships_unique")
        .on("org_memberships")
        .columns(["user_id", "org_id"])
        .unique()
        .execute();

    await db.schema
        .createTable("org_instances")
        .addColumn("id", "text", (col) => col.primaryKey())
        .addColumn("org_id", "text", (col) => col.notNull().references("organizations.id"))
        .addColumn("container_id", "text")
        .addColumn("host", "text")
        .addColumn("port", "integer")
        .addColumn("status", "text", (col) => col.notNull().defaultTo("provisioning"))
        .addColumn("health_checked_at", "text")
        .addColumn("created_at", "text", (col) => col.notNull().defaultTo(sql`(datetime('now'))`))
        .execute();

    await db.schema
        .createIndex("idx_org_instances_org")
        .on("org_instances")
        .column("org_id")
        .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
    await db.schema.dropTable("org_instances").ifExists().execute();
    await db.schema.dropTable("org_memberships").ifExists().execute();
    await db.schema.dropTable("organizations").ifExists().execute();
}
