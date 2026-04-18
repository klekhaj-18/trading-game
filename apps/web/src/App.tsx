import { Route, Routes } from "react-router-dom";
import { LoginPage } from "./routes/login";
import { OnboardingPage } from "./routes/onboarding";
import { PlaybookPage } from "./routes/playbook";
import { PaddockPage } from "./routes/paddock";
import { PitWallPage } from "./routes/pit-wall";
import { LeaderboardPage } from "./routes/leaderboard";
import { AppShell } from "./routes/app-shell";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route element={<AppShell />}>
        <Route path="/" element={<LeaderboardPage />} />
        <Route path="/pit-wall" element={<PitWallPage />} />
        <Route path="/playbook" element={<PlaybookPage />} />
        <Route path="/paddock" element={<PaddockPage />} />
      </Route>
    </Routes>
  );
}
