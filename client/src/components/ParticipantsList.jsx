import { useState } from 'react';
import ConfirmDialog from './ConfirmDialog';

const ROLE_COLORS = {
  host:        '#f59e0b',
  moderator:   '#3b82f6',
  participant: '#22c55e',
  viewer:      '#94a3b8'
};

export default function ParticipantsList({ participants, myUserId, myRole, onRoleChange, onRemove, onTransfer }) {
  const [confirm, setConfirm] = useState(null);

  function ask(message, onOk) {
    setConfirm({ message, onOk });
  }

  const isHost      = myRole === 'host';
  const isModerator = myRole === 'moderator';

  return (
    <div className="participants-box">
      <h3>Participants <span className="count-badge">{participants.length}</span></h3>

      <ul className="participant-list">
        {participants.map(user => {
          const isMe        = user.id === myUserId;
          const isUserHost  = user.role === 'host';
          const canModerate = !isMe && !isUserHost;

          return (
            <li key={user.id} className="participant-item">
              <div className="participant-info">
                <span className="participant-name">
                  {user.name}
                  {isMe && <span className="you-tag"> (you)</span>}
                </span>
                <span className="role-badge" style={{ background: ROLE_COLORS[user.role] || '#94a3b8' }}>
                  {user.role}
                </span>
              </div>

              {/* Host controls */}
              {isHost && canModerate && (
                <div className="participant-actions">
                  <button
                    className="btn-sm secondary"
                    onClick={() => ask(
                      `Change ${user.name}'s role to "${user.role === 'moderator' ? 'participant' : 'moderator'}"?`,
                      () => onRoleChange(user.id, user.role === 'moderator' ? 'participant' : 'moderator')
                    )}
                  >
                    {user.role === 'moderator' ? 'Demote' : 'Promote'}
                  </button>

                  <button
                    className="btn-sm warning"
                    onClick={() => ask(
                      `Make ${user.name} the new host? You'll become a participant.`,
                      () => onTransfer(user.id)
                    )}
                  >
                    Make Host
                  </button>

                  <button
                    className="btn-sm danger"
                    onClick={() => ask(
                      `Remove ${user.name} from the room?`,
                      () => onRemove(user.id)
                    )}
                  >
                    Remove
                  </button>
                </div>
              )}

              {/* Moderator controls — can remove viewers and participants only */}
              {isModerator && canModerate && ['viewer', 'participant'].includes(user.role) && (
                <div className="participant-actions">
                  <button
                    className="btn-sm danger"
                    onClick={() => ask(
                      `Remove ${user.name} from the room?`,
                      () => onRemove(user.id)
                    )}
                  >
                    Remove
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {confirm && (
        <ConfirmDialog
          message={confirm.message}
          onConfirm={() => { confirm.onOk(); setConfirm(null); }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
