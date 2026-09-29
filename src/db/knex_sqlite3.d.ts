// types for the knex sqlite3 dialect NodeSqlite.ts extends
declare module "knex/lib/dialects/sqlite3/index.js" {
  import type { Knex } from "knex";

  interface Sqlite3ConnectionSettings {
    filename: string;
    flags?: string[];
  }

  export default class Client_SQLite3 extends Knex.Client {
    constructor(config: Knex.Config);

    strictForeignKeyPragma: boolean;
    connectionSettings: Sqlite3ConnectionSettings;

    _driver(): unknown;
    _strict(): this & { strictForeignKeyPragma: true };

    schemaCompiler(...args: any[]): any;
    transaction(...args: any[]): Knex.Transaction;
    queryCompiler(builder: any, formatter: any): any;
    queryBuilder(): Knex.QueryBuilder;
    viewCompiler(builder: any, formatter: any): any;
    columnCompiler(...args: any[]): any;
    tableCompiler(...args: any[]): any;
    ddl(compiler: any, pragma: any, connection: any): any;
    wrapIdentifierImpl(value: string): string;

    acquireRawConnection(): Promise<any>;
    destroyRawConnection(connection: any): Promise<void>;

    _query(connection: any, obj: any): Promise<any>;
    _stream(connection: any, obj: any, stream: any): Promise<void>;
    processResponse(obj: any, runner: any): any;

    poolDefaults(): {
      min: number;
      max: number;
      propagateCreateError: boolean;
    };

    formatter(builder: any): any;
    values(values: any, builder: any, formatter: any): any;

    dialect: "sqlite3";
    driverName: "sqlite3";
  }
}
