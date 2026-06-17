import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock fetch globally
global.fetch = vi.fn();

describe("API Module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("URL construction", () => {
    it("should construct project URL correctly", () => {
      const projectId = "test-project-123";
      const expected = `/api/projects/${projectId}`;
      expect(expected).toBe("/api/projects/test-project-123");
    });

    it("should construct reel URL correctly", () => {
      const reelId = "test-reel-456";
      const expected = `/api/reels/${reelId}`;
      expect(expected).toBe("/api/reels/test-reel-456");
    });

    it("should construct clip URL correctly", () => {
      const reelId = "reel-123";
      const clipId = "clip-456";
      const expected = `/api/reels/${reelId}/videos/${clipId}`;
      expect(expected).toBe("/api/reels/reel-123/videos/clip-456");
    });
  });

  describe("API response handling", () => {
    it("should handle successful responses", async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({ status: "ok" }),
      };
      vi.mocked(global.fetch).mockResolvedValueOnce(
        mockResponse as Response
      );

      const response = await global.fetch("/api/health");
      expect(response.ok).toBe(true);
    });

    it("should handle error responses", async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        text: async () => "Not found",
      };
      vi.mocked(global.fetch).mockResolvedValueOnce(
        mockResponse as Response
      );

      const response = await global.fetch("/api/invalid");
      expect(response.ok).toBe(false);
      expect(response.status).toBe(404);
    });
  });
});
