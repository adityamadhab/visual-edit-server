import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import * as t from "@babel/types";

const babelTraverse = traverse.default || traverse;
const babelGenerate = generate.default || generate;

const app = express();

// 🔧 Set this to your real Next.js project root
const SITE_ROOT = path.resolve("../ids-new");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// ---------- helpers ----------
function parseLocator(id) {
  const parts = id.split(":");
  if (parts.length < 3) throw new Error("Invalid id format");
  const col = Number(parts.pop());
  const line = Number(parts.pop());
  const filePath = parts.join(":");
  if (Number.isNaN(line) || Number.isNaN(col)) throw new Error("Invalid line/column");
  return { filePath, line, col };
}

const isValidIdentifier = (key) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);

function makeKeyNode(key) {
  // Use identifier for camelCase like color, backgroundColor; use string literal for dash-case like "font-size"
  return isValidIdentifier(key) ? t.identifier(key) : t.stringLiteral(key);
}

function makeValueNode(val) {
  return typeof val === "number" ? t.numericLiteral(val) : t.stringLiteral(String(val));
}

function buildStyleObject(styles) {
  return t.objectExpression(
    Object.entries(styles).map(([k, v]) => t.objectProperty(makeKeyNode(k), makeValueNode(v)))
  );
}

function upsertStyleAttr(openingEl, incomingStyles) {
  if (!incomingStyles || typeof incomingStyles !== "object") return;

  let styleAttr = openingEl.attributes.find(
    (a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name: "style" })
  );

  if (!styleAttr) {
    openingEl.attributes.push(
      t.jsxAttribute(t.jsxIdentifier("style"), t.jsxExpressionContainer(buildStyleObject(incomingStyles)))
    );
    return;
  }

  // Merge if existing style is an object expression; otherwise replace
  if (
    t.isJSXAttribute(styleAttr) &&
    t.isJSXExpressionContainer(styleAttr.value) &&
    t.isObjectExpression(styleAttr.value.expression)
  ) {
    const obj = styleAttr.value.expression;
    const existing = new Map(
      obj.properties
        .filter((p) => t.isObjectProperty(p))
        .map((p) => [t.isIdentifier(p.key) ? p.key.name : p.key.value, p])
    );
    for (const [k, v] of Object.entries(incomingStyles)) {
      const keyStr = k;
      const nextProp = t.objectProperty(makeKeyNode(keyStr), makeValueNode(v));
      if (existing.has(keyStr)) {
        const node = existing.get(keyStr);
        node.value = nextProp.value;
      } else {
        obj.properties.push(nextProp);
      }
    }
  } else {
    styleAttr.value = t.jsxExpressionContainer(buildStyleObject(incomingStyles));
  }
}

function upsertAttributes(openingEl, attrs) {
  if (!attrs || typeof attrs !== "object") return;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style") continue; // handled separately
    const existing = openingEl.attributes.find(
      (a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name: k })
    );
    const valueNode = t.stringLiteral(String(v));
    if (existing && t.isJSXAttribute(existing)) {
      existing.value = valueNode;
    } else {
      openingEl.attributes.push(t.jsxAttribute(t.jsxIdentifier(k), valueNode));
    }
  }
}
// ---------- /helpers ----------

app.post("/update-element", (req, res) => {
  // Accept both old and new field names
  const styles = req.body.newStyles ?? req.body.styles ?? null;
  const attributes = req.body.newAttributes ?? req.body.attributes ?? null;
  const newText = req.body.newText ?? null;
  const id = req.body.id;

  console.log("📝 Save:", { id, hasText: newText != null, styles, attributes });

  let locator;
  try {
    locator = parseLocator(id);
  } catch (e) {
    return res.status(400).json({ error: "Invalid id", detail: String(e) });
  }

  const absPath = path.join(SITE_ROOT, locator.filePath);
  if (!fs.existsSync(absPath)) {
    return res.status(404).json({ error: `File not found: ${absPath}` });
  }

  try {
    const code = fs.readFileSync(absPath, "utf8");
    const ast = parse(code, { sourceType: "module", plugins: ["jsx", "typescript"] });

    let updated = false;

    babelTraverse(ast, {
      JSXOpeningElement(path) {
        const start = path.node.loc?.start;
        if (!start) return;

        const lineMatch = start.line === locator.line;
        const colMatch = start.column === locator.col || Math.abs(start.column - locator.col) === 1;
        if (!(lineMatch && colMatch)) return;

        const openingEl = path.node;
        const parentEl = path.parentPath.node; // JSXElement

        // Text
        if (typeof newText === "string") {
          const idx = parentEl.children.findIndex((c) => t.isJSXText(c));
          if (idx >= 0 && t.isJSXText(parentEl.children[idx])) {
            parentEl.children[idx].value = newText;
          } else {
            parentEl.children.unshift(t.jsxText(newText));
          }
        }

        // Styles
        if (styles) {
          upsertStyleAttr(openingEl, styles);
        }

        // Attributes (id, className, alt, etc.)
        if (attributes) {
          upsertAttributes(openingEl, attributes);
        }

        updated = true;
        path.stop();
      },
    });

    if (!updated) {
      return res.status(404).json({
        error: "Element not found in AST",
        debug: { id, absPath },
      });
    }

    const output = babelGenerate(ast, { jsescOption: { minimal: true } }, code);
    fs.writeFileSync(absPath, output.code, "utf8");

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ Save error:", err);
    return res.status(500).json({ error: String(err) });
  }
});

app.listen(4000, () => {
  console.log("✍️ Editor backend running on http://localhost:4000");
});
