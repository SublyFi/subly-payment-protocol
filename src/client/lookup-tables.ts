import { fetchAllMaybeAddressLookupTable } from "@solana-program/address-lookup-table";
import { address, getCompiledTransactionMessageDecoder } from "@solana/kit";
import type { SolanaRpc } from "../solana/rpc.js";

/** Lists the lookup table addresses referenced by a serialized transaction. */
export function lookupTableAddressesForTransaction(
  serializedTransaction: string
): string[] {
  const wire = Buffer.from(serializedTransaction, "base64");
  let offset = 0;
  let signatureCount = 0;
  let shift = 0;
  while (offset < wire.length) {
    const byte = wire[offset]!;
    signatureCount |= (byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }
  const messageBytes = wire.subarray(offset + signatureCount * 64);
  const compiled = getCompiledTransactionMessageDecoder().decode(messageBytes);
  const lookups =
    (compiled as { addressTableLookups?: readonly { lookupTableAddress: string }[] })
      .addressTableLookups ?? [];

  return lookups.map((lookup) => String(lookup.lookupTableAddress));
}

/**
 * Fetches lookup table contents through the caller's own RPC so intent
 * validation is anchored to the signer's view of the chain rather than data
 * supplied by the relayer.
 */
export async function fetchLookupTablesForTransaction(
  rpc: SolanaRpc,
  serializedTransaction: string
): Promise<Record<string, readonly string[]>> {
  const addresses = lookupTableAddressesForTransaction(serializedTransaction);
  if (addresses.length === 0) {
    return {};
  }

  const tables = await fetchAllMaybeAddressLookupTable(
    rpc,
    addresses.map((value) => address(value))
  );
  const result: Record<string, readonly string[]> = {};
  for (const table of tables) {
    if (table.exists) {
      result[table.address] = table.data.addresses.map(String);
    }
  }

  return result;
}
