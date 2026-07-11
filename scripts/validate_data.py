#!/usr/bin/env python3
"""
data/*.csv のスキーマを検証するスクリプト。
GitHub Actions から実行し、レシピ/食材データの入力ミスを早期発見する。
"""
import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

SCHEMAS = {
    "ingredients.csv": ["category", "id", "name", "emoji"],
    "recipes.csv": ["name", "needs", "desc", "time_min", "calories"],
    "featured.csv": ["week_start", "ingredient_id", "note"],
}

errors = []


def check_file(filename, required_headers):
    path = DATA / filename
    if not path.exists():
        errors.append(f"[{filename}] ファイルが見つかりません: {path}")
        return None
    with path.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        headers = reader.fieldnames or []
        missing = [h for h in required_headers if h not in headers]
        if missing:
            errors.append(f"[{filename}] ヘッダーが不足しています: {missing}")
            return None
        rows = list(reader)
        if not rows:
            errors.append(f"[{filename}] データ行がありません")
        return rows


def main():
    ingredients = check_file("ingredients.csv", SCHEMAS["ingredients.csv"]) or []
    recipes = check_file("recipes.csv", SCHEMAS["recipes.csv"]) or []
    featured = check_file("featured.csv", SCHEMAS["featured.csv"]) or []

    ingredient_ids = set()
    for i, row in enumerate(ingredients, start=2):
        rid = (row.get("id") or "").strip()
        if not rid:
            errors.append(f"[ingredients.csv:{i}] id が空です")
            continue
        if rid in ingredient_ids:
            errors.append(f"[ingredients.csv:{i}] id が重複しています: {rid}")
        ingredient_ids.add(rid)
        if not (row.get("name") or "").strip():
            errors.append(f"[ingredients.csv:{i}] name が空です: {rid}")
        if not (row.get("category") or "").strip():
            errors.append(f"[ingredients.csv:{i}] category が空です: {rid}")

    recipe_names = set()
    for i, row in enumerate(recipes, start=2):
        name = (row.get("name") or "").strip()
        if not name:
            errors.append(f"[recipes.csv:{i}] name が空です")
            continue
        if name in recipe_names:
            errors.append(f"[recipes.csv:{i}] レシピ名が重複しています: {name}")
        recipe_names.add(name)
        needs = [n.strip() for n in (row.get("needs") or "").split(";") if n.strip()]
        if not needs:
            errors.append(f"[recipes.csv:{i}] needs が空です: {name}")
        for n in needs:
            if ingredient_ids and n not in ingredient_ids:
                errors.append(f"[recipes.csv:{i}] needs '{n}' は ingredients.csv に存在しません（レシピ: {name}）")
        for col in ("time_min", "calories"):
            v = (row.get(col) or "").strip()
            if v and not v.isdigit():
                errors.append(f"[recipes.csv:{i}] {col} は数値である必要があります: '{v}' ({name})")

    for i, row in enumerate(featured, start=2):
        iid = (row.get("ingredient_id") or "").strip()
        if ingredient_ids and iid and iid not in ingredient_ids:
            errors.append(f"[featured.csv:{i}] ingredient_id '{iid}' は ingredients.csv に存在しません")
        ws = (row.get("week_start") or "").strip()
        if ws:
            parts = ws.split("-")
            if len(parts) != 3 or not all(p.isdigit() for p in parts):
                errors.append(f"[featured.csv:{i}] week_start は YYYY-MM-DD 形式にしてください: '{ws}'")

    if errors:
        print(f"❌ 検証エラー {len(errors)} 件:")
        for e in errors:
            print(" -", e)
        sys.exit(1)

    print(f"✅ 検証OK: ingredients={len(ingredients)}, recipes={len(recipes)}, featured={len(featured)}")


if __name__ == "__main__":
    main()
