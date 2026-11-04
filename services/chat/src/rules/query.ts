/** "flipkart" -> {query: "flipkart"}; "amazon US" -> {query: "amazon", country: "US"}. */
export function parseProductQuery(text: string): { query: string; country?: string } {
  const tokens = text.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  const last = tokens[tokens.length - 1];
  if (tokens.length >= 2 && last && /^[A-Za-z]{2}$/.test(last)) {
    return { query: tokens.slice(0, -1).join(" ").slice(0, 60), country: last.toUpperCase() };
  }
  return { query: tokens.join(" ").slice(0, 60) };
}
