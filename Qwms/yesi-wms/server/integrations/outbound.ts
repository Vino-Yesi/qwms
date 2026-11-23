/** TMS carrier booking/tracking and ERP financial posting clients. */
import { z } from 'zod';
import { config } from '../config.js';
import { fail } from '../db/index.js';
import { httpJson, signBody } from './transport.js';

export async function bookTransport(input: {
  shipmentId: string;
  orderExternalId: string;
  carrier: string;
  service: string;
  trackingKey: string;
}): Promise<{
  mode: 'sandbox' | 'live';
  external_id: string;
  tracking_number: string;
  tracking_url?: string;
  label_reference?: string;
}> {
  if (!config.tmsEndpoint) {
    return {
      mode: 'sandbox',
      external_id: `SIM-TMS-${input.shipmentId.slice(0, 8).toUpperCase()}`,
      tracking_number: `SIM${input.shipmentId.replace(/-/g, '').slice(0, 12).toUpperCase()}`,
      tracking_url: `https://tracking.example/sim/${input.shipmentId}`,
      label_reference: `LBL-${input.shipmentId.slice(0, 8).toUpperCase()}`,
    };
  }
  const body = {
    shipment_id: input.shipmentId,
    order_reference: input.orderExternalId,
    carrier: input.carrier,
    service: input.service,
  };
  const response = await httpJson({
    operation: 'confirm_shipment',
    method: 'POST',
    url: config.tmsEndpoint,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Idempotency-Key': input.trackingKey,
      ...signBody(config.tmsSecret, JSON.stringify(body)),
    },
    body,
    idempotencyKey: input.trackingKey,
  });
  const parsed = z
    .object({
      external_id: z.string().min(1),
      tracking_number: z.string().min(1),
      tracking_url: z.string().url().optional(),
      label_reference: z.string().optional(),
      status: z.literal('BOOKED').optional(),
    })
    .safeParse(response.data);
  if (!parsed.success) fail(502, 'TMS_CONTRACT_MISMATCH', 'Carrier booking response did not match the contract');
  const data = parsed.data!;
  return { mode: 'live', external_id: data.external_id, tracking_number: data.tracking_number, tracking_url: data.tracking_url, label_reference: data.label_reference };
}

export async function postToErp(input: {
  idempotencyKey: string;
  payload: unknown;
}): Promise<{ mode: 'sandbox' | 'live'; reference: string; response: unknown }> {
  if (!config.erpEndpoint) {
    return { mode: 'sandbox', reference: `SIM-ERP-${input.idempotencyKey.slice(-12)}`, response: { acknowledgement: 'sandbox' } };
  }
  const body = JSON.stringify(input.payload);
  const response = await httpJson({
    operation: 'push_status',
    method: 'POST',
    url: config.erpEndpoint,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Idempotency-Key': input.idempotencyKey,
      ...signBody(config.erpSecret, body),
    },
    body: input.payload,
    idempotencyKey: input.idempotencyKey,
  });
  const parsed = z
    .object({ acknowledgement: z.string().min(1).optional(), reference: z.string().min(1).optional() })
    .safeParse(response.data);
  if (!parsed.success) fail(502, 'ERP_CONTRACT_MISMATCH', 'ERP response did not match the contract');
  const data = parsed.data!;
  return {
    mode: 'live',
    reference: data.reference || data.acknowledgement || 'ERP-ACK',
    response: response.data,
  };
}
