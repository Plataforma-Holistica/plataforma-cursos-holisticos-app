// Las reglas de los tramos vistos, para la pantalla de la lección (RF-401, T-205): el armado de
// tramos y la cola que guarda el navegador. Son reglas puras del dominio del consumo.
//
// Este archivo viaja al navegador: no importa la base, ni la configuración, ni nada que sea solo
// del servidor. Una prueba de arquitectura sigue sus importaciones y lo exige. Lo que el
// navegador mide es lo que manda de buena fe; lo que cuenta lo decide la base.

export { cutSegment, observeWatch, startSegments, stopSegment, type Segment, type SegmentBuilder, type WatchSample } from "@/domain/consumption/segments";
export {
  batchOf,
  emptyQueue,
  enqueue,
  isOffline,
  parseQueue,
  QUEUE_PREFIX,
  queueKey,
  queueSessionOf,
  resolveBatch,
  retryDelaySeconds,
  settle,
  type BatchVerdict,
  type WatchQueue,
} from "@/domain/consumption/queue";
export type { HeartbeatEvent } from "@/domain/consumption/heartbeat";
