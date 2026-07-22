from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path

from psycopg import connect


TABLES = {
    "batches": (
        "id", "batch_no", "batch_name", "internal_order", "source_filename", "created_at", "updated_at",
    ),
    "skus": (
        "id", "batch_id", "sku_code", "product_name", "style_code", "color_spec", "erp_color_spec",
        "warehouse", "planned_qty", "display_label",
    ),
    "packages": (
        "id", "batch_id", "package_no", "length_cm", "width_cm", "height_cm", "weight_kg", "created_at",
        "updated_at",
    ),
    "package_items": ("id", "package_id", "sku_id", "quantity", "sort_order"),
}


def main() -> int:
    source_path = Path(sys.argv[1] if len(sys.argv) > 1 else "data/packing.db")
    database_url = os.getenv("DATABASE_URL", "")
    if not source_path.is_file():
        print(f"未找到旧数据库：{source_path}")
        return 0
    if not database_url.startswith(("postgresql://", "postgres://")):
        print("DATABASE_URL 不是 PostgreSQL，停止迁移")
        return 1

    source = sqlite3.connect(source_path)
    source.row_factory = sqlite3.Row
    try:
        with connect(database_url) as target:
            existing = target.execute("SELECT COUNT(*) FROM batches").fetchone()[0]
            if existing:
                print(f"PostgreSQL 已有 {existing} 个批次，跳过旧数据迁移")
                return 0
            for table, columns in TABLES.items():
                rows = source.execute(f"SELECT {','.join(columns)} FROM {table} ORDER BY id").fetchall()
                placeholders = ",".join(["%s"] * len(columns))
                column_sql = ",".join(columns)
                for row in rows:
                    target.execute(
                        f"INSERT INTO {table} ({column_sql}) VALUES ({placeholders}) ON CONFLICT DO NOTHING",
                        tuple(row[column] for column in columns),
                    )
                target.execute(
                    "SELECT setval(pg_get_serial_sequence(%s, 'id'), "
                    f"GREATEST(COALESCE((SELECT MAX(id) FROM {table}), 1), 1), "
                    f"EXISTS(SELECT 1 FROM {table}))",
                    (table,),
                )
                print(f"{table}: 已迁移 {len(rows)} 条")
    finally:
        source.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
