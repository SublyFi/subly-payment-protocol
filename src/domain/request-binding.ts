import { hashStableJson } from "../lib/hash.js";

export interface RequestBindingFields {
  sellerRequestId: string;
  httpMethod: string;
  canonicalResourceUrl: string;
  requestBodyHash: string;
  seller: string;
  asset: string;
  amountRawUsdc: string;
  payTo: string;
  sellerUsdcAta: string;
}

export function computeRequestBindingHash(fields: RequestBindingFields): string {
  return hashStableJson({
    sellerRequestId: fields.sellerRequestId,
    httpMethod: fields.httpMethod.toUpperCase(),
    canonicalResourceUrl: fields.canonicalResourceUrl,
    requestBodyHash: fields.requestBodyHash,
    seller: fields.seller,
    asset: fields.asset,
    amountRawUsdc: fields.amountRawUsdc,
    payTo: fields.payTo,
    sellerUsdcAta: fields.sellerUsdcAta
  });
}
