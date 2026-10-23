// What the app reads from Hypha's admin API, as the app (its OAuth token), typed from
// `@hyphacommerce/sdk`'s OpenAPI types through `HyphaClient.admin`.

import type { HyphaClient } from "@hyphacommerce/app";

import type { Installation, Installations } from "./installations.ts";

function getPayment(client: HyphaClient, id: string) {
  return client.admin.GET("/admin/payments/{id}", { params: { path: { id } } });
}

function getOrder(client: HyphaClient, id: string) {
  return client.admin.GET("/admin/orders/{id}", { params: { path: { id } } });
}

/** A payment as Hypha shows it (`PaymentResponse`). */
export type HyphaPayment = NonNullable<Awaited<ReturnType<typeof getPayment>>["data"]>;
/** An order as Hypha shows it (`OrderResponse`), with its payments. */
export type HyphaOrder = NonNullable<Awaited<ReturnType<typeof getOrder>>["data"]>;

/** The payment (`GET /admin/payments/{id}`, `orders:read`); `undefined` when there's none. */
export async function fetchPayment(
  installations: Installations,
  installation: Installation,
  paymentId: string,
): Promise<HyphaPayment | undefined> {
  const { data, response } = await getPayment(installations.client(installation), paymentId);
  if (data) return data;
  if (response.status === 404) return undefined;
  throw new Error(`reading ${paymentId} answered ${response.status}`);
}

/** The order with its payments; `undefined` when there's none. */
export async function fetchOrder(
  installations: Installations,
  installation: Installation,
  orderId: string,
): Promise<HyphaOrder | undefined> {
  const { data, response } = await getOrder(installations.client(installation), orderId);
  if (data) return data;
  if (response.status === 404) return undefined;
  throw new Error(`reading ${orderId} answered ${response.status}`);
}
