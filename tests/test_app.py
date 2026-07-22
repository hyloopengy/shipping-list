import io
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

TEST_DIR = tempfile.TemporaryDirectory()
os.environ["PACKING_DATA_DIR"] = TEST_DIR.name
os.environ["PACKING_DB_PATH"] = str(Path(TEST_DIR.name) / "test.db")

from app import BACKUP_DIR, IS_POSTGRES, app  # noqa: E402
from openpyxl import load_workbook  # noqa: E402


SOURCE = Path(__file__).parents[2] / "拣货单_2026-07-20_17-07-35.xlsx"


class PackingFlowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.config.update(TESTING=True)
        cls.client = app.test_client()
        with cls.client.session_transaction() as current_session:
            current_session["csrf_token"] = "test-csrf-token"
        cls.csrf = {"X-CSRF-Token": "test-csrf-token"}

    def import_source(self, internal_order="测试内部单号"):
        with SOURCE.open("rb") as source:
            response = self.client.post(
                "/api/import",
                data={"internal_order": internal_order, "file": (io.BytesIO(source.read()), SOURCE.name)},
                content_type="multipart/form-data",
                headers=self.csrf,
            )
        self.assertEqual(response.status_code, 201, response.get_json())
        return response.get_json()

    def test_complete_flow(self):
        imported = self.import_source()
        batch_id = imported["batch"]["id"]
        self.assertEqual(len(imported["skus"]), 4)
        self.assertEqual(imported["summary"]["planned"], 87)
        self.assertEqual(imported["batch"]["internal_order"], "测试内部单号")

        sku, second_sku = imported["skus"][:2]
        payload = {
            "package_no": "2#", "clone_count": 2,
            "length_cm": 50, "width_cm": 40, "height_cm": 30, "weight_kg": 12.5,
            "items": [{"sku_id": sku["id"], "quantity": 5}, {"sku_id": second_sku["id"], "quantity": 1}],
        }
        created = self.client.post(f"/api/batches/{batch_id}/packages", json=payload, headers=self.csrf)
        self.assertEqual(created.status_code, 201, created.get_json())
        self.assertEqual(created.get_json()["created"], ["2#", "3#"])

        conflict = self.client.post(f"/api/batches/{batch_id}/packages", json=payload, headers=self.csrf)
        self.assertEqual(conflict.status_code, 400)
        self.assertIn("大包号已存在", conflict.get_json()["error"])

        over = dict(payload, package_no=4, clone_count=1, items=[{"sku_id": sku["id"], "quantity": 3}])
        warning = self.client.post(f"/api/batches/{batch_id}/packages", json=over, headers=self.csrf)
        self.assertEqual(warning.status_code, 409, warning.get_json())
        self.assertEqual(warning.get_json()["overages"][0]["after"], 13)
        over["force"] = True
        forced = self.client.post(f"/api/batches/{batch_id}/packages", json=over, headers=self.csrf)
        self.assertEqual(forced.status_code, 201, forced.get_json())

        export = self.client.get(f"/api/batches/{batch_id}/export")
        self.assertEqual(export.status_code, 200)
        book = load_workbook(io.BytesIO(export.data), data_only=True)
        self.assertEqual(book.sheetnames, ["发货清单", "SKU库存汇总"])
        self.assertEqual(book["发货清单"]["D1"].value, "测试内部单号")
        self.assertEqual(book["发货清单"]["A6"].value, "2#")
        self.assertIn("A6:A7", [str(r) for r in book["发货清单"].merged_cells.ranges])
        self.assertEqual(book["发货清单"]["F2"].value, 37.5)

        latest = forced.get_json()["data"]
        package_two = next(p for p in latest["packages"] if p["package_no"] == 2)
        changed = dict(payload, package_no=2, clone_count=99, items=[{"sku_id": sku["id"], "quantity": 2}])
        updated = self.client.put(f'/api/packages/{package_two["id"]}', json=changed, headers=self.csrf)
        self.assertEqual(updated.status_code, 200, updated.get_json())
        self.assertEqual(updated.get_json()["data"]["summary"]["packed"], 11)

        package_three = next(p for p in updated.get_json()["data"]["packages"] if p["package_no"] == 3)
        deleted = self.client.delete(f'/api/packages/{package_three["id"]}', headers=self.csrf)
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.get_json()["data"]["summary"]["packages"], 2)
        self.assertEqual(deleted.get_json()["data"]["summary"]["packed"], 5)

        if not IS_POSTGRES:
            backups = list(BACKUP_DIR.glob("packing-*.db"))
            self.assertTrue(backups)
            with closing(sqlite3.connect(backups[0])) as backup:
                self.assertGreaterEqual(backup.execute("SELECT COUNT(*) FROM batches").fetchone()[0], 1)

    def test_validation_and_atomic_clone_conflict(self):
        imported = self.import_source()
        batch_id = imported["batch"]["id"]
        sku_id = imported["skus"][0]["id"]
        base = {
            "package_no": 1, "clone_count": 1,
            "length_cm": 50, "width_cm": 40, "height_cm": 30, "weight_kg": 1.25,
            "items": [{"sku_id": sku_id, "quantity": 1}],
        }
        for field, value, expected in [
            ("package_no", "A1", "大包号"), ("length_cm", 1.5, "长"),
            ("weight_kg", 1.234, "重量"), ("items", [], "没有商品"),
            ("clone_count", 501, "最多生成500个大包"),
        ]:
            payload = dict(base)
            payload[field] = value
            response = self.client.post(f"/api/batches/{batch_id}/packages", json=payload, headers=self.csrf)
            self.assertEqual(response.status_code, 400, response.get_json())
            self.assertIn(expected, response.get_json()["error"])

        created = self.client.post(f"/api/batches/{batch_id}/packages", json=base, headers=self.csrf)
        self.assertEqual(created.status_code, 201)
        clone = dict(base, package_no=1, clone_count=3)
        conflict = self.client.post(f"/api/batches/{batch_id}/packages", json=clone, headers=self.csrf)
        self.assertEqual(conflict.status_code, 400)
        current = self.client.get(f"/api/batches/{batch_id}").get_json()
        self.assertEqual(current["summary"]["packages"], 1)

    def test_internal_order_is_required(self):
        with SOURCE.open("rb") as source:
            response = self.client.post(
                "/api/import",
                data={"file": (io.BytesIO(source.read()), SOURCE.name)},
                content_type="multipart/form-data",
                headers=self.csrf,
            )
        self.assertEqual(response.status_code, 400)
        self.assertIn("内部单号", response.get_json()["error"])

        batches = self.client.get("/api/batches").get_json()
        self.assertLessEqual(len(batches), 3)
        found = self.client.get(f'/api/batches?q={batches[0]["batch_no"]}').get_json()
        self.assertEqual(len(found), 1)

    def test_optional_dimensions_and_csrf(self):
        imported = self.import_source("可空尺寸测试")
        batch_id = imported["batch"]["id"]
        sku_id = imported["skus"][0]["id"]
        payload = {
            "package_no": 20,
            "clone_count": 1,
            "length_cm": "",
            "width_cm": None,
            "height_cm": "",
            "weight_kg": "",
            "items": [{"sku_id": sku_id, "quantity": 1}],
        }
        rejected = self.client.post(f"/api/batches/{batch_id}/packages", json=payload)
        self.assertEqual(rejected.status_code, 403)
        created = self.client.post(f"/api/batches/{batch_id}/packages", json=payload, headers=self.csrf)
        self.assertEqual(created.status_code, 201, created.get_json())
        package = created.get_json()["data"]["packages"][0]
        self.assertIsNone(package["length_cm"])
        self.assertIsNone(package["weight_kg"])

    def test_batch_ratios_mixed_package_snapshot_and_excel(self):
        imported = self.import_source("配比测试")
        batch_id = imported["batch"]["id"]
        first, second = imported["skus"][:2]
        ratio_response = self.client.post(
            f"/api/batches/{batch_id}/ratios",
            json={"items": [
                {"sku_id": first["id"], "quantity": 1},
                {"sku_id": first["id"], "quantity": 1},
                {"sku_id": second["id"], "quantity": 1},
            ]},
            headers=self.csrf,
        )
        self.assertEqual(ratio_response.status_code, 201, ratio_response.get_json())
        ratio = ratio_response.get_json()
        self.assertEqual(ratio["name"], "配比1")
        self.assertEqual(ratio["units_per_pack"], 3)
        self.assertEqual(ratio["items"][0]["quantity"], 2)

        created = self.client.post(
            f"/api/batches/{batch_id}/packages",
            json={
                "package_no": 30, "clone_count": 2,
                "entries": [
                    {"entry_type": "sku", "sku_id": first["id"], "pack_count": 1},
                    {"entry_type": "ratio", "ratio_id": ratio["id"], "pack_count": 2},
                ],
            },
            headers=self.csrf,
        )
        self.assertEqual(created.status_code, 201, created.get_json())
        self.assertEqual(created.get_json()["created"], ["30#", "31#"])
        data = created.get_json()["data"]
        self.assertEqual(data["summary"]["packed"], 14)

        package = next(row for row in data["packages"] if row["package_no"] == 30)
        detail = self.client.get(f'/api/packages/{package["id"]}').get_json()
        self.assertEqual(len(detail["entries"]), 2)
        ratio_entry = next(row for row in detail["entries"] if row["entry_type"] == "ratio")
        self.assertEqual(ratio_entry["units_per_pack"], 3)
        self.assertEqual(ratio_entry["pack_count"], 2)
        self.assertEqual(ratio_entry["total_quantity"], 6)

        changed_ratio = self.client.put(
            f'/api/ratios/{ratio["id"]}',
            json={"items": [{"sku_id": first["id"], "quantity": 1}]},
            headers=self.csrf,
        )
        self.assertEqual(changed_ratio.status_code, 200, changed_ratio.get_json())
        self.assertEqual(changed_ratio.get_json()["units_per_pack"], 1)
        snapshot = self.client.get(f'/api/packages/{package["id"]}').get_json()
        old_ratio_entry = next(row for row in snapshot["entries"] if row["entry_type"] == "ratio")
        self.assertEqual(old_ratio_entry["units_per_pack"], 3)
        self.assertIn(f'{second["display_label"]}×1', old_ratio_entry["label"])

        export = self.client.get(f"/api/batches/{batch_id}/export")
        self.assertEqual(export.status_code, 200)
        book = load_workbook(io.BytesIO(export.data), data_only=True)
        sheet = book["发货清单"]
        self.assertEqual(sheet["B5"].value, "款色尺码/配比明细")
        self.assertEqual(sheet["D5"].value, "中包件数")
        self.assertEqual(sheet["E5"].value, "中包数量")
        rows = list(sheet.iter_rows(min_row=6, values_only=True))
        ratio_rows = [row for row in rows if row[1] and str(row[1]).startswith("配比1：")]
        self.assertEqual(ratio_rows[0][2:6], (None, 3, 2, 6))
        self.assertNotIn("\n", str(ratio_rows[0][1]))
        self.assertIn("；", str(ratio_rows[0][1]))
        ratio_row_number = next(index for index in range(6, sheet.max_row + 1) if sheet.cell(index, 2).value == ratio_rows[0][1])
        self.assertGreaterEqual(sheet.row_dimensions[ratio_row_number].height, 36)

        deleted_ratio = self.client.delete(f'/api/ratios/{ratio["id"]}', headers=self.csrf)
        self.assertEqual(deleted_ratio.status_code, 200)
        current_batch = self.client.get(f"/api/batches/{batch_id}").get_json()
        self.assertEqual(current_batch["ratios"], [])
        preserved = self.client.get(f'/api/packages/{package["id"]}').get_json()
        self.assertEqual(next(row for row in preserved["entries"] if row["entry_type"] == "ratio")["units_per_pack"], 3)

        deleted_package = self.client.delete(f'/api/packages/{package["id"]}', headers=self.csrf)
        self.assertEqual(deleted_package.status_code, 200)
        self.assertEqual(deleted_package.get_json()["data"]["summary"]["packed"], 7)

    def test_ratio_batch_isolation_and_validation(self):
        first_batch = self.import_source("配比隔离1")
        second_batch = self.import_source("配比隔离2")
        response = self.client.post(
            f'/api/batches/{second_batch["batch"]["id"]}/ratios',
            json={"items": [{"sku_id": first_batch["skus"][0]["id"], "quantity": 1}]},
            headers=self.csrf,
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn("不属于当前批次", response.get_json()["error"])
        empty = self.client.post(
            f'/api/batches/{second_batch["batch"]["id"]}/ratios', json={"items": []}, headers=self.csrf,
        )
        self.assertEqual(empty.status_code, 400)
        self.assertIn("至少", empty.get_json()["error"])
        malformed_ratio = self.client.post(
            f'/api/batches/{second_batch["batch"]["id"]}/ratios', json={"items": ["<script>"]}, headers=self.csrf,
        )
        self.assertEqual(malformed_ratio.status_code, 400)
        malformed_package = self.client.post(
            f'/api/batches/{second_batch["batch"]["id"]}/packages', json=["not-an-object"], headers=self.csrf,
        )
        self.assertEqual(malformed_package.status_code, 400)

        local_sku = second_batch["skus"][0]
        ratio = self.client.post(
            f'/api/batches/{second_batch["batch"]["id"]}/ratios',
            json={"items": [{"sku_id": local_sku["id"], "quantity": 7}]}, headers=self.csrf,
        ).get_json()
        ratio_package = {
            "package_no": 50, "clone_count": 1,
            "entries": [{"entry_type": "ratio", "ratio_id": ratio["id"], "pack_count": 2}],
        }
        warning = self.client.post(
            f'/api/batches/{second_batch["batch"]["id"]}/packages', json=ratio_package, headers=self.csrf,
        )
        self.assertEqual(warning.status_code, 409)
        self.assertEqual(warning.get_json()["overages"][0]["added"], 14)
        forced = self.client.post(
            f'/api/batches/{second_batch["batch"]["id"]}/packages',
            json=ratio_package | {"force": True}, headers=self.csrf,
        )
        self.assertEqual(forced.status_code, 201, forced.get_json())

    def test_home_security_and_history_search(self):
        home = self.client.get("/")
        self.assertEqual(home.status_code, 200)
        self.assertEqual(home.headers["X-Frame-Options"], "DENY")
        self.assertIn("frame-ancestors 'none'", home.headers["Content-Security-Policy"])
        page = home.get_data(as_text=True)
        self.assertIn('id="batchSearchBtn"', page)
        self.assertIn('role="combobox"', page)
        self.assertIn('aria-controls="suggestions"', page)

        created = [self.import_source(f"历史查询-{number}") for number in range(5)]
        prefix = created[0]["batch"]["batch_no"].split("-")[0]
        history = self.client.get(f"/api/batches?q={prefix}").get_json()
        latest = self.client.get("/api/batches").get_json()
        self.assertGreaterEqual(len(history), 5)
        self.assertLessEqual(len(history), 100)
        self.assertLessEqual(len(latest), 3)


if __name__ == "__main__":
    unittest.main()
