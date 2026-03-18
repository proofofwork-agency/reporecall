import React from "react";

interface ButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

type Theme = "light" | "dark";

enum ButtonVariant {
  Primary = "primary",
  Secondary = "secondary",
}

function formatLabel(text: string): string {
  return text.trim().toUpperCase();
}

const Button: React.FC<ButtonProps> = ({ label, onClick, disabled }) => {
  return <button onClick={onClick} disabled={disabled}>{formatLabel(label)}</button>;
};

class ButtonGroup {
  private buttons: ButtonProps[] = [];

  addButton(props: ButtonProps): void {
    this.buttons.push(props);
  }

  render(): JSX.Element[] {
    return this.buttons.map((b, i) => <Button key={i} {...b} />);
  }
}

export { Button, ButtonGroup };
