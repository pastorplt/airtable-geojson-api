const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());

const API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = process.env.AIRTABLE_BASE_ID;
const TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;

app.get("/", async (req, res) => {
  try {
    const records = [];
    let offset = "";

    do {
      const response = await axios.get(
        `https://api.airtable.com/v0/${BASE_ID}/${TABLE_NAME}?pageSize=100${offset ? `&offset=${offset}` : ''}`,
        {
          headers: { Authorization: `Bearer ${API_KEY}` }
        }
      );

      records.push(...response.data.records);
      offset = response.data.offset;
    } while (offset);

    const features = records.map((r) => {
      try {
        const geometry = JSON.parse(r.fields["Polygon"]);
        return {
          type: "Feature",
          geometry,
          properties: {
            Network: r.fields["Network Name"] || "",
            Leaders: r.fields["Network Leader Names"] || ""
          }
        };
      } catch {
        return null;
      }
    }).filter(Boolean);

    res.json({ type: "FeatureCollection", features });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch data from Airtable" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
