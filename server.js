import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import * as t from "@babel/types";

// Fix for @babel/traverse & generator ESM compatibility
const babelTraverse = traverse.default || traverse;
const babelGenerate = generate.default || generate;

const app = express();

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.use(express.json());

// Path to your Next.js site root (adjust if needed)
const SITE_ROOT = path.resolve("../ids-new");

function parseId(id) {
  // id format: relative/path/to/file.tsx:LINE:COL
  const parts = id.split(":");
  if (parts.length < 3) throw new Error("Invalid id format");
  const col = Number(parts.pop());
  const line = Number(parts.pop());
  const filePath = parts.join(":"); // supports colons in path
  if (Number.isNaN(line) || Number.isNaN(col)) throw new Error("Invalid line/col in id");
  return { filePath, line, col };
}

app.post("/update-element", (req, res) => {
  const { id, newText } = req.body;

  console.log("🔍 Update request received:");
  console.log("  ID:", id);
  console.log("  New Text:", newText);

  let parsed;
  try {
    parsed = parseId(id);
  } catch (err) {
    return res.status(400).json({ error: "Invalid id format", detail: String(err) });
  }

  try {
    const absPath = path.join(SITE_ROOT, parsed.filePath);

    console.log("📁 File path:", absPath);
    console.log("📁 File exists:", fs.existsSync(absPath));

    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ error: `File not found: ${absPath}` });
    }

    const code = fs.readFileSync(absPath, "utf8");
    console.log("📄 File content length:", code.length);
    console.log("📄 First 200 chars:", code.substring(0, 200) + "...");

    const ast = parse(code, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
      // locations are on by default; keep them
    });

    console.log("🌳 AST parsed successfully");

    let updated = false;
    let elementsFound = 0;
    let elementsWithDataId = 0;

    babelTraverse(ast, {
      JSXElement(path) {
        elementsFound++;
        const opening = path.node.openingElement;

        // Count and log any data-appopen-id attributes we find (for debugging)
        const dataIdAttr = opening.attributes.find(
          (a) =>
            t.isJSXAttribute(a) &&
            t.isJSXIdentifier(a.name) &&
            a.name.name === "data-appopen-id"
        );

        if (dataIdAttr) {
          elementsWithDataId++;
          const dataIdValue = t.isStringLiteral(dataIdAttr.value) ? dataIdAttr.value.value : 'non-string';
          console.log(`  Element ${elementsWithDataId}: data-appopen-id="${dataIdValue}"`);
        }

        // 1) Prefer exact attribute match
        const attrMatch = opening.attributes.find(
          (a) =>
            t.isJSXAttribute(a) &&
            t.isJSXIdentifier(a.name) &&
            a.name.name === "data-appopen-id" &&
            t.isStringLiteral(a.value) &&
            a.value.value === id
        );

        // 2) Fallback: match by location (line/column)
        let locMatch = false;
        if (!attrMatch && opening.loc && opening.loc.start) {
          const nodeLine = opening.loc.start.line;
          const nodeCol = opening.loc.start.column;
          // Compare with parsed values (the loader used loc.start)
          if (nodeLine === parsed.line && nodeCol === parsed.col) {
            locMatch = true;
          } else {
            // Sometimes column offsets differ (0 vs 1 based). Try relaxed check:
            if (nodeLine === parsed.line && Math.abs(nodeCol - parsed.col) <= 1) {
              locMatch = true;
            }
          }
        }

        if (attrMatch || locMatch) {
          console.log("✅ Found matching element! (attrMatch:", !!attrMatch, "locMatch:", locMatch, ")");
          // Find the first text child (JSXText) and update it, otherwise insert one
          const textChildIndex = path.node.children.findIndex((child) => t.isJSXText(child));
          if (textChildIndex >= 0) {
            const textChild = path.node.children[textChildIndex];
            if (t.isJSXText(textChild)) {
              console.log("📝 Updating existing text child:", JSON.stringify(textChild.value).slice(0,80));
              textChild.value = newText;
            }
          } else {
            // If there are no text children, try to find a JSXExpressionContainer with string literal
            let foundExpression = false;
            for (let i = 0; i < path.node.children.length; i++) {
              const ch = path.node.children[i];
              if (t.isJSXExpressionContainer(ch) && t.isStringLiteral(ch.expression)) {
                (ch.expression.value = newText);
                foundExpression = true;
                break;
              }
            }
            if (!foundExpression) {
              console.log("📝 Adding new text child");
              path.node.children.unshift(t.jsxText(newText));
            }
          }

          updated = true;
          path.stop();
        }
      },
    });

    console.log("🔢 Traversal complete:");
    console.log("  Total JSX elements found:", elementsFound);
    console.log("  Elements with data-appopen-id:", elementsWithDataId);
    console.log("  Element updated:", updated);

    if (!updated) {
      return res.status(404).json({
        error: "Element not found in AST",
        debug: {
          searchingFor: id,
          parsed,
          filePath: absPath,
          totalElements: elementsFound,
          elementsWithDataId: elementsWithDataId,
        },
      });
    }

    console.log("💾 Generating updated code...");
    const output = babelGenerate(ast, { jsescOption: { minimal: true } }, code);

    console.log("📝 Writing file:", absPath);
    fs.writeFileSync(absPath, output.code, "utf8");

    console.log("✅ Update successful!");
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error occurred:");
    console.error("  Message:", err && err.message);
    console.error("  Stack:", err && err.stack);
    res.status(500).json({ error: err ? String(err) : "unknown error" });
  }
});

app.listen(4000, () => {
  console.log("✍️ Editor backend running on http://localhost:4000");
});
