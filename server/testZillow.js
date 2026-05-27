import { getZillowPropertyDetails } from "./services/crawler/zillowScraper.js";

const url =
  "https://www.zillow.com/homedetails/3316-Walnut-Hill-Ln-Dallas-TX-75229/26810383_zpid/";

async function run() {
  console.log(`Fetching data for: ${url}`);
  const result = await getZillowPropertyDetails(url);

  if (!result) {
    console.log(
      "No data returned. Make sure Zillow isn't blocking the request (403).",
    );
    return;
  }

  console.log("\n--- SALES HISTORY ---");
  const sales = result.salesHistory || [];
  sales.forEach((sale) => {
    console.log(
      `${sale.date || "Unknown Date"} | Event: ${sale.event || "N/A"} | Price: $${(sale.price || 0).toLocaleString()} | Buyer Agent: ${sale.buyerAgent?.name || "N/A"}`,
    );
  });

  console.log("\n--- OWNERS / TAX RECORDS (Deed info if available) ---");
  const taxes = result.taxHistory || [];
  // Zillow typically obscures owner names for privacy, but tax history has the tax statements.
  if (taxes.length > 0) {
    console.log(`Found ${taxes.length} tax records.`);
    taxes.slice(0, 3).forEach((tax) => {
      console.log(
        `${tax.time || tax.year} | Value: $${(tax.value || 0).toLocaleString()} | Tax Paid: $${(tax.taxPaid || 0).toLocaleString()}`,
      );
    });
  } else {
    console.log(
      "No tax history or owner deed info found directly from Zillow.",
    );
  }
}

run();
