/** Un catalogue anglais a exactement les clés du français (vérifié par TypeScript). */
export type Catalog<T> = { [K in keyof T]: T[K] extends string ? string : Catalog<T[K]> };
