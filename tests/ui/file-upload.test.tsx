import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FileUpload } from "@/ui/file-upload";

const file = new File(["x"], "clase.mp4", { type: "video/mp4" });

function setup(disabled = false) {
  const onFile = vi.fn();
  render(<FileUpload label="Elige el video" hint="MP4 o MOV" accept=".mp4,.mov" onFile={onFile} disabled={disabled} />);
  return { onFile, input: screen.getByLabelText<HTMLInputElement>("Elige el video") };
}

describe("FileUpload", () => {
  it("el control nativo siempre está, con su nota y lo que admite", () => {
    const { input } = setup();
    expect(input.type).toBe("file");
    expect(input.accept).toBe(".mp4,.mov");
    expect(input).toHaveAccessibleDescription("MP4 o MOV");
  });

  it("avisa al elegir, y se vacía: elegir el mismo otra vez vuelve a avisar", () => {
    const { input, onFile } = setup();
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith(file);
    expect(input.value).toBe("");
  });

  it("arrastrar un archivo avisa igual, y se marca mientras está encima", () => {
    const { onFile } = setup();
    const zone = screen.getByTestId("file-upload");
    fireEvent.dragOver(zone, { dataTransfer: { files: [] } });
    expect(zone.className).toContain("border-accent");
    fireEvent.dragLeave(zone);
    expect(zone.className).not.toContain("border-accent");
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(onFile).toHaveBeenCalledWith(file);
  });

  it("apagado no acepta lo que le suelten", () => {
    const { onFile, input } = setup(true);
    expect(input).toBeDisabled();
    fireEvent.drop(screen.getByTestId("file-upload"), { dataTransfer: { files: [file] } });
    expect(onFile).not.toHaveBeenCalled();
  });
});
