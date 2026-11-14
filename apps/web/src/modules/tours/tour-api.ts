// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The tour routes, typed by the shared wire contract (`@liaison/shared`
 * tours/api). The store talks to this interface only, so unit tests hand it a
 * fake and Playwright can stub the routes.
 */
import type {
  ListToursResponse,
  StartTourRequest,
  TourListItem,
  TourProgress,
  TourProgressResponse,
  TourSource,
  UpdateTourRequest,
} from "@liaison/shared"
import type { createApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"

type ApiClient = ReturnType<typeof createApiClient>

export interface TourApi {
  list(): Promise<TourListItem[]>
  start(tourId: string, source: TourSource): Promise<TourProgress | null>
  /** A 409 (stale `fromBeatId`) resolves to the fresh progress instead of throwing. */
  update(tourId: string, body: UpdateTourRequest): Promise<TourProgress | null>
  progress(tourId: string): Promise<TourProgress | null>
  /** A read tool's answer to the signed-in person (a step's figures), as the screen reads it. */
  readTool?(tool: string, params: Record<string, unknown>): Promise<unknown>
}

const path = (tourId: string) => `/tours/${encodeURIComponent(tourId)}`

export function createTourApi(client: ApiClient): TourApi {
  const progress = async (tourId: string) =>
    (await client.get<TourProgressResponse>(`${path(tourId)}/progress`)).progress
  return {
    list: async () => (await client.get<ListToursResponse>("/tours")).tours,
    start: async (tourId, source) => {
      const body: StartTourRequest = { source }
      return (await client.post<TourProgressResponse>(`${path(tourId)}/start`, body)).progress
    },
    update: async (tourId, body) => {
      try {
        return (
          await client.patch<TourProgressResponse>(path(tourId), body, {
            suppressGlobalError: true,
          })
        ).progress
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) return progress(tourId)
        throw err
      }
    },
    progress,
    readTool: (tool, params) =>
      client.post<unknown>(`/apps/tools/${tool}`, params, { suppressGlobalError: true }),
  }
}
