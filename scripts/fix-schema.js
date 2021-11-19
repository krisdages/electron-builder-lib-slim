const fs = require("fs")
const path = require("path")

const schemaFile = path.join(__dirname, "../packages/app-builder-lib/scheme.json")
const schema = JSON.parse(fs.readFileSync(schemaFile, "utf-8"))

o = schema.properties["$schema"] = {
  "description": "JSON Schema for this document.",
  "type": ["null", "string"],
}

fs.writeFileSync(schemaFile, JSON.stringify(schema, null, 2))
