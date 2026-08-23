/* ---------- External ---------- */
import Newstack from "@moureau/newstack";

/* ---------- Pages ---------- */
import { Game } from "./Game";

/* ---------- Styles ---------- */
import "./styles.css";

export class Application extends Newstack {
  render() {
    return (
      <div>
        <Game route="/" />
      </div>
    );
  }
}
