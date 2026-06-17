import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReelSidebar } from "../components/ReelSidebar";
import type { ClipSummary } from "../api";

describe("ReelSidebar Component", () => {
  const mockClips: ClipSummary[] = [
    {
      id: "clip-1",
      name: "video1.mp4",
      duration: 100,
      width: 1920,
      height: 1080,
      fps: 30,
      status: "transcribed",
      language: "en",
      transcribed: true,
    },
    {
      id: "clip-2",
      name: "video2.mp4",
      duration: 200,
      width: 1920,
      height: 1080,
      fps: 30,
      status: "created",
      language: null,
      transcribed: false,
    },
  ];

  const mockProps = {
    clips: mockClips,
    activeId: "clip-1",
    busyIds: [],
    progressMsg: "",
    onSelect: vi.fn(),
    onReorder: vi.fn(),
    onRemove: vi.fn(),
    onAddVideos: vi.fn(),
    onTranscribeAll: vi.fn(),
    onStopTranscribe: vi.fn(),
  };

  it("should render sidebar with clips", () => {
    render(<ReelSidebar {...mockProps} />);
    expect(screen.getByText("Videos")).toBeInTheDocument();
    expect(screen.getByText("video1.mp4")).toBeInTheDocument();
    expect(screen.getByText("video2.mp4")).toBeInTheDocument();
  });

  it("should display clip count", () => {
    render(<ReelSidebar {...mockProps} />);
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("should have Add videos button", () => {
    render(<ReelSidebar {...mockProps} />);
    expect(screen.getByText("+ Add videos")).toBeInTheDocument();
  });

  it("should show Transcribe all button when clips exist", () => {
    render(<ReelSidebar {...mockProps} />);
    expect(screen.getByText("Transcribe all")).toBeInTheDocument();
  });

  it("should show empty state when no clips", () => {
    const emptyProps = { ...mockProps, clips: [] };
    render(<ReelSidebar {...emptyProps} />);
    expect(screen.getByText("No videos yet.")).toBeInTheDocument();
  });

  it("should display transcribed status", () => {
    render(<ReelSidebar {...mockProps} />);
    expect(screen.getByText("transcribed")).toBeInTheDocument();
  });

  it("should show loading indicator during progress", () => {
    const progressProps = { ...mockProps, progressMsg: "uploading…" };
    render(<ReelSidebar {...progressProps} />);
    expect(screen.getByText(/uploading/)).toBeInTheDocument();
  });

  it("should show Stop transcribing button when transcribing", () => {
    const busyProps = { ...mockProps, busyIds: ["clip-2"] };
    render(<ReelSidebar {...busyProps} />);
    expect(screen.getByText("Stop transcribing")).toBeInTheDocument();
  });
});
