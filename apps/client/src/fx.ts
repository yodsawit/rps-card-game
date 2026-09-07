import Phaser from "phaser";

interface LaneClashFx {
  laneIndex: number;
  outcome: "win" | "loss" | "draw";
  x: number;
  y: number;
}

class AtmosphereScene extends Phaser.Scene {
  private battleHandler: ((payload: LaneClashFx) => void) | null = null;

  constructor() {
    super("atmosphere");
  }

  create(): void {
    const { width, height } = this.scale;
    for (let index = 0; index < 24; index += 1) {
      const warm = index % 3 === 0;
      const orb = this.add.circle(
        Phaser.Math.Between(0, width),
        Phaser.Math.Between(0, height),
        Phaser.Math.Between(1, 4),
        warm ? 0xffb45b : 0x6ae6d9,
        Phaser.Math.FloatBetween(0.08, 0.3)
      );
      this.tweens.add({
        targets: orb,
        y: orb.y - Phaser.Math.Between(30, 120),
        x: orb.x + Phaser.Math.Between(-35, 35),
        alpha: { from: orb.alpha, to: 0.02 },
        duration: Phaser.Math.Between(4_000, 9_000),
        yoyo: true,
        repeat: -1,
        ease: "Sine.InOut"
      });
    }

    this.battleHandler = (payload) => this.laneClash(payload);
    this.game.events.on("lane-clash-fx", this.battleHandler);
    this.events.once("shutdown", () => {
      if (this.battleHandler) this.game.events.off("lane-clash-fx", this.battleHandler);
    });
  }

  private laneClash({ outcome, x, y }: LaneClashFx): void {
    const color = outcome === "win" ? 0x6ae6d9 : outcome === "loss" ? 0xff6178 : 0xffc76a;
    const { width, height } = this.scale;
    const impactX = Phaser.Math.Clamp(x, 0, width);
    const impactY = Phaser.Math.Clamp(y, 0, height);
    const ring = this.add.circle(impactX, impactY, 12, color, 0).setStrokeStyle(4, color, 0.9);
    this.tweens.add({
      targets: ring,
      scale: 8,
      alpha: 0,
      duration: 520,
      ease: "Cubic.Out",
      onComplete: () => ring.destroy()
    });
    this.cameras.main.shake(85, 0.0025);

    for (let index = 0; index < 18; index += 1) {
      const particle = this.add.circle(impactX, impactY, Phaser.Math.Between(2, 5), color, 0.82);
      const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
      const distance = Phaser.Math.Between(55, Math.max(105, Math.floor(width * 0.12)));
      this.tweens.add({
        targets: particle,
        x: impactX + Math.cos(angle) * distance,
        y: impactY + Math.sin(angle) * distance * 0.65,
        alpha: 0,
        scale: 0.2,
        duration: Phaser.Math.Between(420, 760),
        ease: "Cubic.Out",
        onComplete: () => particle.destroy()
      });
    }
  }
}

export function startEffects(): Phaser.Game {
  return new Phaser.Game({
    type: Phaser.AUTO,
    parent: "phaser-root",
    transparent: true,
    scene: [AtmosphereScene],
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: "100%",
      height: "100%"
    },
    render: {
      antialias: true,
      pixelArt: false
    }
  });
}
