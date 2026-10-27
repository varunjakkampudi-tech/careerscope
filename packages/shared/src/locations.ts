/**
 * Place-name knowledge shared by the provider pre-filter and the matching
 * engine, so both agree which names are the same job market.
 */

/** Cities that share a job market, so a Gurgaon role suits a Delhi candidate. */
export const METROS: readonly (readonly string[])[] = [
  ['delhi', 'new delhi', 'gurgaon', 'gurugram', 'noida', 'ghaziabad', 'faridabad', 'ncr'],
  ['bangalore', 'bengaluru', 'whitefield', 'electronic city'],
  ['mumbai', 'navi mumbai', 'thane', 'pune'],
  ['hyderabad', 'secunderabad', 'gachibowli', 'hitec city', 'telangana'],
  ['chennai', 'madras'],
  ['kochi', 'cochin', 'ernakulam', 'trivandrum', 'thiruvananthapuram'],
  ['san francisco', 'bay area', 'palo alto', 'mountain view', 'san jose', 'sunnyvale'],
  ['new york', 'nyc', 'brooklyn', 'jersey city'],
];
