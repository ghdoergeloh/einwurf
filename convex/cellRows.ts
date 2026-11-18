import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { fineChildrenOf, isLegacyCell, legacyParentOf, markCellOf } from "./cells";

/**
 * Markierungen oder Notizen einer Zelle (cells.ts), auch solche, die noch im alten Raster
 * gespeichert sind. Nach migrations:fineCells ist der Bereich der alten Zelle leer und kostet
 * fast nichts.
 * - Neue Zelle: ihre Einträge plus die noch alten Einträge der umgebenden alten Zelle, die in ihr liegen.
 * - Alte Zelle (ältere, noch geöffnete Seite): ihre alten Einträge plus die ihrer neuen Zellen.
 */
export async function rowsInCell<T extends "marks" | "notes">(
  ctx: QueryCtx,
  table: T,
  campaignId: Id<"campaigns">,
  cell: string,
): Promise<Doc<T>[]> {
  const read = (key: string) =>
    ctx.db
      .query(table as "marks")
      .withIndex("by_campaign_cell", (q) => q.eq("campaignId", campaignId).eq("cell", key))
      .collect() as unknown as Promise<Doc<T>[]>;
  if (isLegacyCell(cell)) {
    const out = await read(cell);
    for (const fine of fineChildrenOf(cell)) out.push(...(await read(fine)));
    return out;
  }
  const own = await read(cell);
  const legacy = (await read(legacyParentOf(cell))).filter((d) => markCellOf(d.center[0], d.center[1]) === cell);
  return [...own, ...legacy];
}
