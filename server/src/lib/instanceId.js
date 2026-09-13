import { nanoid } from 'nanoid';

/**
 * A stable id for this process, generated once at boot.
 *
 * This is the cheapest possible proof that horizontal scaling actually works:
 * it is exposed at /healthz and in the socket `hello` event, and the client
 * renders it as a corner badge. Two browser windows showing two *different*
 * instance ids while exchanging messages is a self-evident multi-instance demo.
 */
export const instanceId =
  process.env.INSTANCE_ID ?? process.env.FLY_MACHINE_ID ?? `local-${nanoid(8)}`;
