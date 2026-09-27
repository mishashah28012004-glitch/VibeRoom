export default function ConfirmDialog({ message, onConfirm, onCancel }) {
  return (
    <div className="confirm-overlay">
      <div className="confirm-box">
        <p>{message}</p>
        <div className="btn-row">
          <button className="btn primary"   onClick={onConfirm}>Confirm</button>
          <button className="btn secondary" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
