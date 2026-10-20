import { BudgetScreen } from "../features/budget/BudgetScreen";
import { GuestGate } from "../features/me/GuestGate";

export default function Route() {
  return <GuestGate feature="budget">{() => <BudgetScreen />}</GuestGate>;
}
