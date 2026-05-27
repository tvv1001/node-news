// mlsData.js
// Loads and queries Realtor.com MLS data from CSV files in server/data/mls

import fs from "fs";
import path from "path";
import * as csvParse from "csv-parse/sync";

const DATA_DIR = path.join(process.cwd(), "server", "data", "national", "mls");

let mlsRecords = [];

function normalizeText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\broad\b/g, "rd")
    .replace(/\bboulevard\b/g, "blvd")
    .replace(/\bdrive\b/g, "dr")
    .replace(/\blane\b/g, "ln")
    .replace(/\bcourt\b/g, "ct")
    .replace(/\bplace\b/g, "pl")
    .replace(/\btrail\b/g, "trl")
    .replace(/\bhighway\b/g, "hwy")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function getRowValue(row = {}, keys = []) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }

  return "";
}

export function toMLSRecord(row = {}) {
  return {
    address: getRowValue(row, [
      "address",
      "street_address",
      "property_address",
    ]),
    city: getRowValue(row, ["city", "city_name"]),
    state: getRowValue(row, ["state", "state_code"]),
    zipCode: getRowValue(row, ["zip", "zip_code", "postal_code"]),
    mlsNumber: getRowValue(row, ["mls_number", "mlsNumber", "mls"]),
    lastSoldDate: getRowValue(row, [
      "last_sold_date",
      "lastSoldDate",
      "sold_date",
    ]),
  };
}

export function loadMLSData(filename = "us-housing-data.csv") {
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) return [];
  const csv = fs.readFileSync(filePath, "utf8");
  mlsRecords = csvParse.parse(csv, {
    columns: true,
    skip_empty_lines: true,
  });
  return mlsRecords;
}

export function findMLSByAddress(address, city, state, zip) {
  if (!mlsRecords.length) return [];

  const wantedAddress = normalizeText(address);
  const wantedCity = normalizeText(city);
  const wantedState = normalizeText(state);
  const wantedZip = String(zip || "").match(/\d{5}/)?.[0] || "";

  return mlsRecords.filter((row) => {
    const record = toMLSRecord(row);
    const recordAddress = normalizeText(record.address);
    const recordCity = normalizeText(record.city);
    const recordState = normalizeText(record.state);
    const recordZip = String(record.zipCode || "").match(/\d{5}/)?.[0] || "";

    const addressMatches =
      !wantedAddress ||
      recordAddress === wantedAddress ||
      recordAddress.includes(wantedAddress) ||
      wantedAddress.includes(recordAddress);
    const cityMatches = !wantedCity || !recordCity || recordCity === wantedCity;
    const stateMatches =
      !wantedState || !recordState || recordState === wantedState;
    const zipMatches =
      !wantedZip || !recordZip || recordZip.startsWith(wantedZip);

    return addressMatches && cityMatches && stateMatches && zipMatches;
  });
}

export function findMLSByNumber(mlsNumber) {
  if (!mlsRecords.length) return null;

  const wanted = normalizeText(mlsNumber);
  return (
    mlsRecords.find(
      (row) =>
        normalizeText(getRowValue(row, ["mls_number", "mlsNumber", "mls"])) ===
        wanted,
    ) || null
  );
}
