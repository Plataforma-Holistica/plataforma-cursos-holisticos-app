import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ui } from "@/messages/es/ui";
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

  // Con `user-event`: vaciar el control vacía su lista de archivos, como en un navegador (con `fireEvent` no).
  it("avisa al elegir, y se vacía: elegir el mismo otra vez vuelve a avisar", async () => {
    const { input, onFile } = setup();
    const user = userEvent.setup();
    await user.upload(input, file);
    expect(onFile).toHaveBeenCalledWith(file);
    expect(input.value).toBe("");
    await user.upload(input, file);
    expect(onFile).toHaveBeenCalledTimes(2);
    // Vacío también a la vista: un archivo rechazado no se queda como si siguiera elegido.
    expect(screen.getByText(ui.fileInput.none)).toBeInTheDocument();
    expect(screen.queryByText("clase.mp4")).not.toBeInTheDocument();
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
