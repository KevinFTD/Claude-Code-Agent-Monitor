/**
 * @file StatusBadge.test.tsx
 * @description Unit tests for the StatusBadge component, which includes AgentStatusBadge and SessionStatusBadge. These components are responsible for displaying the status of agents and sessions in the dashboard. The tests cover rendering of different statuses, application of pulse animation based on status, and respect for explicit pulse overrides. The tests use React Testing Library and Vitest for assertions and mocking.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentStatusBadge, SessionStatusBadge } from "../StatusBadge";

describe("AgentStatusBadge", () => {
  it("should render waiting status", () => {
    render(<AgentStatusBadge status="waiting" />);
    expect(screen.getByText("Waiting")).toBeInTheDocument();
  });

  it("should render working status", () => {
    render(<AgentStatusBadge status="working" />);
    expect(screen.getByText("Working")).toBeInTheDocument();
  });

  it("should render completed status", () => {
    render(<AgentStatusBadge status="completed" />);
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("should render error status", () => {
    render(<AgentStatusBadge status="error" />);
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("should apply pulse animation for working status by default", () => {
    const { container } = render(<AgentStatusBadge status="working" />);
    const dot = container.querySelector(".animate-pulse-dot");
    expect(dot).toBeInTheDocument();
  });

  it("should not apply pulse for connected status (now working - has pulse)", () => {
    const { container } = render(<AgentStatusBadge status="working" />);
    const dot = container.querySelector(".animate-pulse-dot");
    expect(dot).toBeInTheDocument();
  });

  it("does not pulse an idle waiting badge (no reason)", () => {
    const { container } = render(<AgentStatusBadge status="waiting" />);
    expect(container.querySelector(".animate-pulse-dot")).not.toBeInTheDocument();
  });

  it("pulses an action-required waiting badge", () => {
    const { container } = render(<AgentStatusBadge status="waiting" reason="action" />);
    expect(container.querySelector(".animate-pulse-dot")).toBeInTheDocument();
  });

  it("should respect explicit pulse=false override", () => {
    const { container } = render(<AgentStatusBadge status="working" pulse={false} />);
    const dot = container.querySelector(".animate-pulse-dot");
    expect(dot).not.toBeInTheDocument();
  });

  it("should respect explicit pulse=true override", () => {
    const { container } = render(<AgentStatusBadge status="waiting" pulse={true} />);
    const dot = container.querySelector(".animate-pulse-dot");
    expect(dot).toBeInTheDocument();
  });

  it("renders idle waiting as a quiet gray 'Waiting' badge", () => {
    const { container } = render(<AgentStatusBadge status="waiting" />);
    expect(screen.getByText("Waiting")).toBeInTheDocument();
    expect(container.querySelector(".animate-pulse-dot")).not.toBeInTheDocument();
    expect(container.querySelector(".bg-gray-400")).toBeInTheDocument();
  });

  it("renders action-required waiting as a red 'Needs You' badge with pulse", () => {
    const { container } = render(<AgentStatusBadge status="waiting" reason="action" />);
    expect(screen.getByText("Needs You")).toBeInTheDocument();
    expect(container.querySelector(".animate-pulse-dot")).toBeInTheDocument();
    expect(container.querySelector(".bg-red-400")).toBeInTheDocument();
  });
});

describe("SessionStatusBadge", () => {
  it("should render active status", () => {
    render(<SessionStatusBadge status="active" />);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("should render completed status", () => {
    render(<SessionStatusBadge status="completed" />);
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("should render error status", () => {
    render(<SessionStatusBadge status="error" />);
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("should render abandoned status", () => {
    render(<SessionStatusBadge status="abandoned" />);
    expect(screen.getByText("Abandoned")).toBeInTheDocument();
  });

  it("renders idle waiting as a quiet gray 'Waiting' badge", () => {
    const { container } = render(<SessionStatusBadge status="waiting" />);
    expect(screen.getByText("Waiting")).toBeInTheDocument();
    // Session badge omits the dot entirely when not pulsing (idle) — assert the
    // muted badge color instead.
    expect(container.querySelector(".animate-pulse-dot")).not.toBeInTheDocument();
    expect(container.querySelector(".text-gray-400")).toBeInTheDocument();
  });

  it("renders action-required waiting as a red 'Needs You' badge with pulse", () => {
    const { container } = render(<SessionStatusBadge status="waiting" reason="action" />);
    expect(screen.getByText("Needs You")).toBeInTheDocument();
    expect(container.querySelector(".animate-pulse-dot")).toBeInTheDocument();
    expect(container.querySelector(".bg-red-400")).toBeInTheDocument();
  });
});
