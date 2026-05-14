# Maritime Ship Optimizer

A high-performance maritime supply chain simulation and optimization tool built with React and Recharts. This application helps visualize and optimize ship schedules, docking intervals (staggering), and port utilization.

![Ship Optimizer Screenshot](https://via.placeholder.com/800x450.png?text=Ship+Optimizer+Interface)

## 🚢 Features

- **Discrete Event Simulation**: Simulates ship movements, loading/unloading operations, and port queuing over configurable time horizons.
- **Dynamic Gantt Charts**: Interactive visualization of ship schedules and port occupancy.
- **KPI Dashboard**: Real-time tracking of average utilization, non-productive time, voyage counts, and cargo throughput.
- **Stagger Optimization**: Automated sensitivity analysis to find the optimal arrival interval that minimizes idle time and maximizes efficiency.
- **Multi-Route Support**: Pre-configured routes for various ports (Semarang, Cilacap, Palembang, Gresik, Bontang).
- **Responsive Design**: Premium dark/light mode interface with glassmorphism elements.

## 🛠 Tech Stack

- **Framework**: [React](https://reactjs.org/)
- **Build Tool**: [Vite](https://vitejs.dev/)
- **Charts**: [Recharts](https://recharts.org/)
- **Styling**: Vanilla CSS with modern Design Tokens

## 🚀 Getting Started

### Prerequisites

- Node.js (v18 or later)
- npm or yarn

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/YanAkhra/Ship-Optimizer-PILOG.git
   cd Ship-Optimizer-PILOG
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

4. Build for production:
   ```bash
   npm run build
   ```

## 📊 How It Works

The simulation engine uses an interval-scheduling berth allocator. It processes:
1. **Owned Ships**: Iterative round-trips with staggered starts.
2. **External Ships**: Randomized arrivals based on monthly probability distributions.

The "Cari Stagger Optimal" feature runs multiple simulations across a range of stagger intervals (1–15 days) to identify the "sweet spot" where port congestion is minimized without sacrificing ship utilization.

## 📝 License

This project is licensed under the ISC License.
