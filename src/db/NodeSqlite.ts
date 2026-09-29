// knex client for Node's built-in node:sqlite
import Client_SQLite3 from "knex/lib/dialects/sqlite3/index.js";
import type { PathLike } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  StatementSync,
  SQLInputValue,
  SQLOutputValue,
  StatementResultingChanges,
  DatabaseSyncOptions,
} from "node:sqlite";

export type NodeSqliteOptions = {
  filename: PathLike;
  options: DatabaseSyncOptions & { safeIntegers?: boolean };
};

export class NodeSQLite extends Client_SQLite3 {
  static driverName = "node:sqlite";
  get filename() {
    return (this.connectionSettings as NodeSqliteOptions).filename;
  }
  get options() {
    return (this.connectionSettings as NodeSqliteOptions).options ?? {};
  }

  _driver() {
    return DatabaseSync;
  }

  async acquireRawConnection() {
    return new this.driver(this.filename, this.options);
  }

  async destroyRawConnection(connection: DatabaseSync) {
    return connection.close();
  }

  async _query(
    connection: DatabaseSync,
    obj: {
      bindings: SQLInputValue[];
      context: unknown;
      method: string;
      response: Record<string, SQLOutputValue>[] | StatementResultingChanges;
      returning: boolean;
      sql: string;
      options?: {
        safeIntegers?: boolean;
      };
    },
  ) {
    if (!obj.sql) {
      throw new Error("The query is empty");
    }
    if (!connection) {
      throw new Error("No connection provided");
    }
    const statement = connection.prepare(obj.sql);
    const safeIntegers = obj.options?.safeIntegers ?? this.options.safeIntegers;
    if (safeIntegers !== undefined) {
      statement.setReadBigInts(safeIntegers);
    }

    const { method, returning } = obj;
    let callMethod: keyof StatementSync;
    switch (method) {
      case "insert":
      case "update":
        callMethod = returning ? "all" : "run";
        break;
      case "counter":
      case "del":
        callMethod = "run";
        break;
      default:
        callMethod = "all";
    }

    if (!statement[callMethod]) {
      throw new Error(`Error calling ${callMethod} on connection.`);
    }
    if (callMethod === "all") {
      const response = statement.all(...this._formatBindings(obj.bindings));
      obj.response = response;
      return obj;
    }
    const response = statement.run(...this._formatBindings(obj.bindings));
    obj.response = response;
    obj.context = {
      lastID: (response as StatementResultingChanges).lastInsertRowid,
      changes: (response as StatementResultingChanges).changes,
    };
    return obj;
  }

  _formatBindings(bindings?: SQLInputValue[]) {
    if (!bindings) {
      return [];
    }
    return bindings.map((binding) => {
      if (binding instanceof Date) {
        return binding.valueOf();
      }
      if (typeof binding === "boolean") {
        return Number(binding);
      }
      return binding;
    });
  }
}
