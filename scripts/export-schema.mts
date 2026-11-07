// Writes the JSON Schema version of BuildingModel for teams not using TypeScript.
// Run: npm run schema
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { BuildingModel } from "../packages/schema/building-model.ts";

const schema = z.toJSONSchema(BuildingModel, { io: "input" });
writeFileSync(
  new URL("../packages/schema/building-model.schema.json", import.meta.url),
  JSON.stringify(schema, null, 2) + "\n",
);
console.log("wrote packages/schema/building-model.schema.json");

// Sample model the WiFi team can copy the shape of.
const { colonialTemplate } = await import("../lib/model/templates.ts");
const sample = BuildingModel.parse(
  colonialTemplate({ id: "demo", lat: 42.7298, lng: -73.6789, address: "Demo house — Troy, NY" }),
);
writeFileSync(
  new URL("../public/demo/demo-house.json", import.meta.url),
  JSON.stringify(sample, null, 2) + "\n",
);
console.log("wrote public/demo/demo-house.json (validated)");
